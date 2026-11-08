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
import { resolveSafetyProfile } from "./safety-profile.js";

const MAX_REASON_SUBJECT = 300;
export const MAX_APPROVAL_SUBJECT_BYTES = 65_536;
export const MAX_APPROVAL_PREVIEW_BYTES = 65_536;

/** Preserve command whitespace. Oversized subjects cannot be approved partially. */
function fullSubject(subject) {
  const text = String(subject ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_APPROVAL_SUBJECT_BYTES) {
    throw new Error(`Approval subject exceeds ${MAX_APPROVAL_SUBJECT_BYTES} bytes; split the operation for complete review.`);
  }
  return text;
}

function boundedPreview(preview) {
  const text = String(preview ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_APPROVAL_PREVIEW_BYTES) return text;
  // Keep the UTF-8 prefix valid; the boundary may split a multi-byte character.
  let end = MAX_APPROVAL_PREVIEW_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[Diff preview truncated at ${MAX_APPROVAL_PREVIEW_BYTES} bytes; not the complete change.]`;
}

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
   * @param {object} [host] Optional trusted host metadata for profile restrictions.
   * @returns {RiskAssessment & { denied?: string }}
   */
  function assessCommand(command, host) {
    const text = String(command ?? "");
    // Without host metadata keep the v0.6.3 configured-initialization contract:
    // global static hard denials only, no Agent approval or profile escalation.
    const patterns = host ? compileDenyPatterns(resolveSafetyProfile(config, host).denyCommandPatterns) : denyPatterns;
    for (const pattern of patterns) {
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
   * @param {string} [options.preview] Optional bounded multiline Diff for approval only.
   * @returns {string}
   */
  function buildReason({ action, host, subject, verb, description, preview, targetEvidence }) {
    const target = formatHost(host);
    const named = host.name !== undefined && host.name !== host.host ? `${host.name} (${target})` : target;
    const safety = resolveSafetyProfile(config, host);
    const label = actionLabel(action);
    const risk = verb ? ` (risk: ${truncateSubject(verb)})` : "";
    const lines = [`Remote ${label} on ${named}${risk}`];
    if (host.viaHost) lines.push(`SSH entrance: ${host.viaHost} (${target}); terminal destination is initialized by saved actions, not inferred from arbitrary output.`);
    if (safety.profiles.length) lines.push(`Safety profiles: ${safety.profiles.join(", ")}`);
    if (safety.environments.length) lines.push(`Environment: ${safety.environments.join(", ")}`);
    lines.push(`Impact (configured, not automatically verified): ${safety.impacts.length ? safety.impacts.join("; ") : "not specified; review the complete subject below"}`);
    if (description?.trim()) lines.push(`Reason: ${truncateSubject(description)}`);
    if (targetEvidence) {
      lines.push(`Target check before approval: ${targetEvidence.status}; checks will be repeated immediately before execution in the actual command context.`);
      for (const check of (targetEvidence.checks ?? []).slice(0, 10)) {
        const safe = value => JSON.stringify(String(value ?? "unknown").slice(0, 4096));
        lines.push(`Check ${safe(check.name)}: command=${safe(check.command)}, expected=${safe(check.expected)}, actual=${safe(check.actual)}, status=${check.status}, exit=${check.exitCode ?? "unknown"}`);
      }
    }
    lines.push(`${action === "execute" ? "Complete command" : "Complete subject"}:\n${fullSubject(subject)}`);
    if (preview !== undefined) lines.push(`Diff preview:\n${boundedPreview(preview)}`);
    return lines.join("\n");
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
   * @param {string} [options.preview] Optional bounded multiline Diff for approval only.
   * @param {boolean} [options.readonlyHost] Host is force-read-only.
   * @returns {Promise<{ allowed: boolean, reason?: string, outcome?: string }>}
   */
  async function authorize({ toolName, exec, host, action, subject, mutating, unproven = false, verb, description, readonlyHost, preview, targetEvidence, requireApproval = false }) {
    const safety = resolveSafetyProfile(config, host);
    // Validate before any early allow: never approve/execute an unseen suffix.
    try { fullSubject(subject); } catch (error) { return { allowed: false, reason: error.message }; }
    const assessment = action === "execute" ? assessCommand(subject, host) : undefined;
    if (assessment?.denied) return { allowed: false, reason: assessment.denied };
    const changesState = mutating === true || assessment?.level === "high";
    const unprovenState = unproven === true || assessment?.level === "gray";
    // A read-only host accepts only actions the classifier proves read-only.
    if ((readonlyHost === true || safety.readonly) && (changesState || unprovenState)) {
      return {
        allowed: false,
        reason: `Host ${host.name} is configured read-only; ${actionLabel(action)} is denied.`,
      };
    }
    if (!changesState && !unprovenState && safety.policy !== "always" && !requireApproval) return { allowed: true };
    if (safety.policy === "never") {
      return {
        allowed: false,
        reason: `Approval policy is "never": remote ${actionLabel(action)} on ${host.name} is denied.`,
      };
    }
    // "auto": only provably mutating commands ask; unproven commands run unless
    // the deployment opts back into approval with unprovenCommands: "ask".
    if (!changesState && unprovenState && safety.policy !== "always" && safety.unprovenCommands !== "ask" && !requireApproval) {
      return { allowed: true };
    }

    const reason = buildReason({ action, host, subject, verb: verb ?? assessment?.verb, description, preview, targetEvidence });
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
