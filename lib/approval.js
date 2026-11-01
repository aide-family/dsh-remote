/**
 * Approval gate for dsh-remote.
 *
 * Risk is reviewed statically first (Crescent-style classifier), then the
 * configured policy decides whether the action is allowed, denied, or handed to
 * the DSH approval seam (`ctx.get("approval")`, the same one-shot, fail-closed
 * seam the sandboxed bash tool uses).
 *
 * Policy modes (`config.policy`):
 *   - "auto"   read-only actions run; anything mutating asks for approval
 *   - "always" every action asks for approval
 *   - "never"  read-only actions run; anything mutating is denied outright
 *              (the headless / unattended stance)
 *
 * Independent hard denials, applied before policy:
 *   - a host matched by `readonlyHosts` forbids every mutating action
 *   - a command matched by `denyCommandPatterns` is always denied
 */

import { classifyCommand, extractRiskVerb } from "./policy/index.js";

const MAX_REASON_SUBJECT = 300;

/** @typedef {{ level: "low" | "gray" | "high", verb: string }} RiskAssessment */

/**
 * Compile the configured deny patterns once, skipping invalid entries with a
 * warning instead of failing the whole plugin.
 *
 * @param {string[] | undefined} patterns RegExp sources from config.
 * @param {(message: string) => void} [warn] Warning sink.
 * @returns {RegExp[]}
 */
export function compileDenyPatterns(patterns, warn) {
  /** @type {RegExp[]} */
  const compiled = [];
  for (const source of patterns ?? []) {
    const text = String(source ?? "").trim();
    if (text.length === 0) continue;
    try {
      compiled.push(new RegExp(text));
    } catch (error) {
      warn?.(`dsh-remote: ignoring invalid denyCommandPatterns entry ${JSON.stringify(text)}: ${describe(error)}`);
    }
  }
  return compiled;
}

/**
 * Shorten a model-supplied command or path for an approval prompt without
 * hiding which action is being approved.
 *
 * @param {string} subject Raw command/path.
 * @returns {string}
 */
export function truncateSubject(subject) {
  const text = String(subject ?? "").replaceAll(/\s+/gu, " ").trim();
  return text.length <= MAX_REASON_SUBJECT ? text : `${text.slice(0, MAX_REASON_SUBJECT - 1)}…`;
}

/** @param {unknown} error @returns {string} */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create the approval gate used by every tool.
 *
 * @param {object} options
 * @param {import("@deepseek-ai/cordis").Context} options.ctx Plugin context (for `ctx.get("approval")`).
 * @param {object} options.config Normalized dsh-remote config.
 * @param {{ info?: (m: string) => void, warn?: (m: string) => void }} [options.logger]
 */
export function createApprovalGate({ ctx, config, logger }) {
  const denyPatterns = compileDenyPatterns(config.denyCommandPatterns, (message) => logger?.warn?.(message));

  /**
   * Static review of one remote command.
   *
   * @param {string} command The shell line that would run on the remote host.
   * @returns {RiskAssessment & { denied?: string }}
   */
  function assessCommand(command) {
    const text = String(command ?? "");
    for (const pattern of denyPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        return {
          level: "high",
          verb: extractRiskVerb(text),
          denied: `command denied by denyCommandPatterns (${pattern.source})`,
        };
      }
    }
    const { level, verb } = classifyCommand(text);
    return { level, verb };
  }

  /**
   * Build the human-facing reason shown in the approval prompt. It always names
   * the action, the exact host, and the concrete subject.
   *
   * @param {object} options
   * @param {"read" | "write" | "execute" | "transfer"} options.action
   * @param {import("../lib/hosts.js").RemoteHost} options.host
   * @param {string} options.subject Command or path being acted on.
   * @param {string} [options.verb] Risk verb from the static classifier.
   * @param {string} [options.description] Model-supplied short description.
   * @returns {string}
   */
  function buildReason({ action, host, subject, verb, description }) {
    const target = formatHost(host);
    // Name the configured alias as well as the connection target: the alias is
    // what the user and the model recognise, the target proves where it lands.
    const named = host.name !== undefined && host.name !== host.host ? `${host.name} (${target})` : target;
    const label = actionLabel(action);
    const risk = verb ? ` (risk: ${verb})` : "";
    const why = description?.trim() ? ` — ${truncateSubject(description)}` : "";
    return `Remote ${label} on ${named}${risk}: ${truncateSubject(subject)}${why}`;
  }

  /**
   * Decide one real action and, when required, ask the user through the DSH
   * approval seam. Approval is fail-closed: a missing/failed answerer denies.
   *
   * @param {object} options
   * @param {string} options.toolName Model-facing tool name (for the audit log).
   * @param {import("@deepseek-ai/dsh-tools").ToolExecution} options.exec Tool execution carrying agent/callId/signal.
   * @param {import("../lib/hosts.js").RemoteHost} options.host Target host.
   * @param {"read" | "write" | "execute" | "transfer"} options.action Action category.
   * @param {string} options.subject Exact command or path.
   * @param {boolean} options.mutating Whether the static classifier proves the action changes remote state.
   * @param {boolean} [options.unproven] The classifier could not prove the action read-only (gray).
   * @param {string} [options.verb] Risk verb from {@link assessCommand}.
   * @param {string} [options.description] Model-supplied short description.
   * @param {boolean} [options.readonlyHost] Host is force-read-only.
   * @returns {Promise<{ allowed: boolean, reason?: string, outcome?: string }>}
   */
  async function authorize({ toolName, exec, host, action, subject, mutating, unproven = false, verb, description, readonlyHost }) {
    const changesState = mutating === true;
    const unprovenState = unproven === true;
    // A read-only host accepts only actions the classifier proves read-only.
    if (readonlyHost === true && (changesState || unprovenState)) {
      return {
        allowed: false,
        reason: `Host ${host.name} is configured read-only; ${actionLabel(action)} is denied.`,
      };
    }
    if (!changesState && !unprovenState && config.policy !== "always") return { allowed: true };
    if (config.policy === "never") {
      return {
        allowed: false,
        reason: `Approval policy is "never": remote ${actionLabel(action)} on ${host.name} is denied.`,
      };
    }
    // "auto": only provably mutating commands ask; unproven commands run unless
    // the deployment opts back into approval with unprovenCommands: "ask".
    if (!changesState && unprovenState && config.unprovenCommands !== "ask") {
      return { allowed: true };
    }

    const reason = buildReason({ action, host, subject, verb, description });
    const approval = ctx?.get?.("approval");
    if (approval === undefined || approval === null) {
      return {
        allowed: false,
        outcome: "unavailable",
        reason: `${reason} — denied because no approval answerer is mounted (fail closed).`,
      };
    }

    let outcome;
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        reason,
        signal: exec.signal,
      });
    } catch (error) {
      return {
        allowed: false,
        outcome: "unavailable",
        reason: `${reason} — denied because the approval request failed: ${describe(error)}`,
      };
    }

    if (outcome === "allowed-once") return { allowed: true, outcome };
    if (outcome === "rejected") {
      return { allowed: false, outcome, reason: `${reason} — rejected by the user.` };
    }
    if (outcome === "cancelled") {
      return { allowed: false, outcome, reason: `${reason} — the approval request was cancelled.` };
    }
    if (outcome === "unavailable") {
      return {
        allowed: false,
        outcome,
        reason: `${reason} — denied because no approval answerer is available (fail closed).`,
      };
    }
    return {
      allowed: false,
      outcome: "unavailable",
      reason: `${reason} — denied: unexpected approval outcome ${JSON.stringify(outcome)}.`,
    };
  }

  return { assessCommand, authorize, buildReason };
}

/**
 * @param {import("../lib/hosts.js").RemoteHost} host
 * @returns {string}
 */
export function formatHost(host) {
  const user = host.username?.trim();
  const target = `${host.host ?? host.name}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  return user ? `${user}@${target}` : target;
}

/** @param {"read" | "write" | "execute" | "transfer"} action */
function actionLabel(action) {
  switch (action) {
    case "execute":
      return "command execution";
    case "read":
      return "read";
    case "write":
      return "file write";
    case "transfer":
      return "file transfer";
    default:
      return "operation";
  }
}
