/**
 * Model-facing tools for persistent remote shell (PTY) sessions.
 *
 * Six tools wrap the owner-scoped shell manager:
 *   remote_shell_open / send / read / signal / close / list
 *
 * Safety: opening a shell is not a mutation, but every *submitted* input line is
 * risk-reviewed exactly like `remote_exec` (static classifier -> approval policy
 * -> fail closed), signals are mutating actions, and read-only hosts deny
 * mutating input. Raw input (`submit: false`, e.g. control characters) is not
 * classified because it does not execute a line by itself.
 */

import {
  MAX_TITLE_CHARS,
  describeError,
  oneLine,
  shortText,
  splitLines,
  throwIfAborted,
} from "../render.js";
import { resolveSafetyProfile } from "../safety-profile.js";
import { targetConnectionDigest, targetChecksDigest } from "../target-binding.js";

/** Default render budget for one shell result (bytes of model-facing text). */
const DEFAULT_RENDER_BYTES = 262_144;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"];

/**
 * @param {object} deps
 * @param {Function} deps.defineTool `@deepseek-ai/dsh-tools` factory.
 * @param {object} deps.config Normalized plugin config.
 * @param {object} deps.manager `createShellManager()` instance.
 * @param {object} deps.approval Approval gate (`lib/approval.js`).
 * @param {object} deps.hosts Host store (`lib/host-store.js`).
 * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [deps.logger]
 * @returns {any[]} ToolDefinitions in protocol order.
 */
export function createShellTools({ defineTool, config, manager, approval, hosts, live, logger, targets }) {
  if (typeof defineTool !== "function") throw new Error("createShellTools: defineTool is required");
  if (manager === undefined || manager === null) throw new Error("createShellTools: manager is required");
  if (approval === undefined || approval === null) throw new Error("createShellTools: approval is required");
  if (hosts === undefined || hosts === null) throw new Error("createShellTools: hosts is required");

  const maxBytes = positiveInt(config?.terminalMaxReadBytes, DEFAULT_RENDER_BYTES);

  /** Resolve the host object behind a live session for reasons and policy. */
  async function hostOf(agent, sessionId) {
    await targets?.refresh?.();
    await hosts.list?.({ refresh: true });
    const described = manager.describe(agent, sessionId);
    const host = await hosts.find(described.host);
    if (!host || !hosts.isAllowed(host)) throw Object.assign(new Error("Current logical host is unavailable or denied by allowHosts."), { code: "DENIED" });
    const checks = targets?.checksFor ? targets.checksFor(host) : resolveSafetyProfile(config, host).targetChecks ?? [];
    const expectedConnectionDigest = targetConnectionDigest(host);
    if (described.connectionDigest !== undefined && described.connectionDigest !== expectedConnectionDigest) throw Object.assign(new Error("The PTY is bound to an older/different logical connection; reconnect explicitly."), { code: "TARGET_CONNECTION_CHANGED" });
    return { described, host, expectedChecksHash: targetChecksDigest(checks), expectedConnectionDigest, hasChecks: checks.length > 0 };
  }

  /** Revalidate the initial unguarded route after approval, immediately before input.
   * A newly configured guard requires a NEW operation, never an upgrade of old approval.
   */
  async function dispatchInput({ agent, sessionId, host, expectedChecksHash, expectedConnectionDigest, text, submit, approvedOnce, signal }) {
    throwIfAborted(signal);
    await hosts.list?.({ refresh: true });
    let current;
    let checks;
    if (typeof targets?.dispatchCheck === "function") {
      const fresh = await targets.dispatchCheck({ host, expectedChecksHash, expectedConnectionDigest,
        ...(submit ? { command: text } : {}), mutating: submit ? approval.assessCommand(text, host).level === "high" : true,
        ptyInput: true, approvedOnce });
      current = fresh?.host; checks = fresh?.checks;
      if (!current || !Array.isArray(checks)) throw Object.assign(new Error("Fresh PTY dispatch validation is unavailable; no input submitted."), { code: "TARGET_DISPATCH_UNAVAILABLE" });
    } else {
      await targets?.refresh?.();
      current = await hosts.find(host.name);
      if (!current) throw Object.assign(new Error("Logical host is unavailable before PTY dispatch."), { code: "DENIED" });
      checks = targets?.checksFor ? targets.checksFor(current) : resolveSafetyProfile(config, current).targetChecks ?? [];
    }
    if (!hosts.isAllowed(current)) throw Object.assign(new Error("Current logical host is denied by allowHosts."), { code: "DENIED" });
    if (targetConnectionDigest(current) !== expectedConnectionDigest) throw Object.assign(new Error("Logical host connection/routing changed during approval; no input submitted."), { code: "TARGET_CONNECTION_CHANGED" });
    if (targetChecksDigest(checks) !== expectedChecksHash || checks.length > 0) throw Object.assign(new Error("Target-check binding changed during approval; start a fresh verified operation."), { code: "TARGET_CONFIG_CHANGED" });
    const described = manager.describe(agent, sessionId);
    if (described.host !== current.name || (described.connectionDigest !== undefined && described.connectionDigest !== expectedConnectionDigest)) throw Object.assign(new Error("PTY connection changed before dispatch; no input submitted."), { code: "TARGET_CONNECTION_CHANGED" });
    const safety = resolveSafetyProfile(config, current);
    if (hosts.isReadonly(current) || safety.readonly || safety.policy === "never") throw Object.assign(new Error("Unverified PTY input is denied by current read-only/never policy."), { code: "DENIED" });
    const subject = submit ? text : `Raw interactive input (unknown foreground parser): ${JSON.stringify(text)}`;
    const risk = approval.assessCommand(subject, current);
    if (risk.denied) throw Object.assign(new Error(risk.denied), { code: "DENIED" });
    if (!approvedOnce && (!submit || safety.policy === "always" || risk.level === "high" || (risk.level === "gray" && safety.unprovenCommands === "ask"))) throw Object.assign(new Error("Current approval requirements differ; request a fresh one-shot approval."), { code: "DENIED" });
    throwIfAborted(signal);
  }

  /** Bound one rendered text value at a UTF-8 safe boundary. */
  function bounded(text) {
    const value = String(text ?? "");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let cut = maxBytes;
    let slice = Buffer.from(value, "utf8").subarray(0, cut).toString("utf8");
    while (Buffer.byteLength(slice, "utf8") > maxBytes && cut > 0) {
      cut -= 1;
      slice = Buffer.from(value, "utf8").subarray(0, cut).toString("utf8");
    }
    return `${slice}\n[output truncated at ${maxBytes} bytes]`;
  }

  /** Render a session status line. */
  function statusLine(status) {
    if (status?.kind === "exited") {
      return `session exited: ${status.exitCode ?? status.signal ?? "unknown"}`;
    }
    return "session running";
  }

  const tools = [];

  tools.push(
    defineTool({
      name: "remote_shell_open",
      description:
        "Open or reuse this conversation's persistent interactive shell (PTY) on a remote host. When the DSH native terminal is enabled, this is the same PTY shown in the terminal, so a human can type or send Ctrl-C there and you can continue with remote_shell_read/send. The session is owned by this agent; close it with remote_shell_close when done. Use it only when you need persistent shell state or interactive input — prefer remote_exec/remote_read/remote_write for bounded work. Returns the sessionId, startup output, and status. An exited shared session is not silently reconnected; reopening starts a fresh shell.",
      parameters: {
        host: {
          type: "string",
          required: true,
          description: "Host name from remote_hosts.",
        },
        cwd: {
          type: "string",
          description: "Optional remote directory to enter after the shell starts (~ allowed).",
        },
        name: {
          type: "string",
          description: "Optional owner-local label for the session.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          {
            type: "text",
            text: bounded(
              `started remote shell ${value.sessionId} on ${value.host} (${statusLine(value.status)})${value.sharedTerminal === true ? " — shared with this conversation's DSH terminal" : ""}\n${value.motd ?? ""}`.trimEnd(),
            ),
          },
        ],
      },
      presentCall(args) {
        return {
          card: "generic",
          kind: "execute",
          title: `Open remote shell on ${shortText(args.host, "host", MAX_TITLE_CHARS)}`,
        };
      },
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const query = requireText(args.host, "host");
        const host = await hosts.find(query);
        if (!hosts.isAllowed(host)) {
          throw new Error(`Host ${host.name} is not allowed by the allowHosts policy.`);
        }
        const liveCommand = beginLive(live, {
          sessionId: sessionIdOf(exec),
          tool: "remote_shell_open",
          host: host.name,
          command: `open persistent shell${args.cwd === undefined ? "" : ` in ${args.cwd}`}`,
          kind: "shell-open",
        });
        try {
          const decision = await approval.authorize({
            toolName: "remote_shell_open",
            exec,
            host,
            action: "execute",
            subject: `open persistent shell${args.cwd === undefined ? "" : ` in ${args.cwd}`}`,
            mutating: false,
            description: "open a persistent remote shell session",
            readonlyHost: hosts.isReadonly(host),
          });
          if (!decision.allowed) throw new Error(decision.reason);
          const opened = await manager.open({
            agent: exec.agent,
            host,
            ...(args.cwd === undefined ? {} : { cwd: String(args.cwd) }),
            ...(args.name === undefined ? {} : { name: String(args.name) }),
            signal: exec.signal,
          });
          liveCommand?.note(`shell ${opened.sessionId} started on ${host.name}\n`);
          liveCommand?.end({ code: 0 });
          return {
            kind: "open",
            sessionId: opened.sessionId,
            host: host.name,
            status: opened.status,
            motd: opened.motd ?? "",
            sharedTerminal: opened.sharedTerminal === true,
          };
        } catch (error) {
          liveCommand?.end({ error: describeError(error) });
          throw error;
        }
      },
    }),
  );

  tools.push(
    defineTool({
      name: "remote_shell_send",
      description:
        "Write text to a persistent remote shell session and wait for it to settle. By default Enter is submitted and every submitted line is risk-reviewed like remote_exec: read-only input runs, mutating or unknown input needs approval and is denied under policy never or on read-only hosts. Set submit=false for raw control input (e.g. Ctrl-C or an incomplete REPL line). Returns the output produced by this send, the wait reason (inferred_idle/timeout/session_exit), and the session status. Only one send may be active per session; inferred_idle or timeout never prove the command exited.",
      parameters: {
        sessionId: {
          type: "string",
          required: true,
          description: "Session id returned by remote_shell_open or remote_shell_list.",
        },
        text: {
          type: "string",
          required: true,
          description: "UTF-8 text to write to the shell.",
        },
        submit: {
          type: "boolean",
          description: "Submit Enter after the text (default true).",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          {
            type: "text",
            text: bounded(
              [
                value.viewport ?? "",
                `[wait: ${value.waitReason}] [${statusLine(value.sessionStatus)}]`,
                Number.isInteger(value.exitCode) ? `[exit code: ${value.exitCode}] [target: ${value.targetEvidence?.status ?? "unknown"}]` : "",
                value.truncated ? "[output truncated]" : "",
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            ),
          },
        ],
      },
      presentCall(args) {
        return {
          card: "generic",
          kind: "execute",
          title: `Send to remote shell: ${oneLine(args.text, 60)}`,
        };
      },
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const sessionId = requireText(args.sessionId, "sessionId");
        const text = typeof args.text === "string" ? args.text : "";
        if (text.length === 0) throw new Error("text must be a non-empty string");
        if (args.submit !== undefined && typeof args.submit !== "boolean") throw Object.assign(new Error("submit must be a boolean; invalid input modes are not dispatched."), { code: "SHELL_INPUT_INVALID" });
        const submit = args.submit ?? true;
        if (submit && /[\x00-\x1f\x7f]/u.test(text)) throw Object.assign(new Error("Submitted PTY commands must be one printable line without editing controls; use approved raw input or a signal tool."), { code: "SHELL_INPUT_INVALID" });
        if (!submit && /[\r\n]/u.test(text)) throw Object.assign(new Error("Raw input must not contain Enter/line submission bytes."), { code: "SHELL_INPUT_INVALID" });
        const { described, host, expectedChecksHash, expectedConnectionDigest, hasChecks } = await hostOf(exec.agent, sessionId);
        let approvedOnce = false;
        const liveCommand = beginLive(live, {
          sessionId: sessionIdOf(exec),
          tool: "remote_shell_send",
          host: described.host,
          command: submit ? text : "[raw input omitted]",
          kind: "shell",
        });
        const startedAt = Date.now();
        try {
          const safety = resolveSafetyProfile(config, host);
          if (submit && !hasChecks && (hosts.isReadonly(host) || safety.readonly || safety.policy === "never")) throw Object.assign(new Error('Unverified PTY input cannot prove read-only execution; readonly/ policy is "never" requires configured checks and a verified context. Use one-shot read tools instead.'), { code: "DENIED" });
          if (!submit && hasChecks) throw Object.assign(new Error("Target-checked PTYs require complete commands; use remote_shell_signal for interruption."), { code: "TARGET_PARTIAL_INPUT" });
          const guarded = submit && hasChecks;
          if (guarded && !targets?.execute) throw Object.assign(new Error("Configured target guard is unavailable; no command executed."), { code: "TARGET_GUARD_UNAVAILABLE" });
          if (!submit) {
            const decision = await approval.authorize({ toolName: "remote_shell_send", exec, host, action: "execute",
              subject: `Raw interactive input (unknown foreground parser): ${JSON.stringify(text)}`, mutating: true,
              unproven: true, requireApproval: true, readonlyHost: hosts.isReadonly(host), description: "Raw bytes may affect an interactive program; never use this channel for credentials" });
            if (decision.allowed !== true) throw Object.assign(new Error(decision.reason ?? "Raw input denied."), { code: "DENIED", outcome: decision.outcome });
            approvedOnce = decision.outcome === "allowed-once";
          }
          if (submit && !guarded) {
            const risk = approval.assessCommand(text);
            if (risk.denied !== undefined) throw new Error(risk.denied);
            const mutating = risk.level === "high";
            const unproven = risk.level === "gray";
            const decision = await approval.authorize({
              toolName: "remote_shell_send",
              exec,
              host,
              action: "execute",
              subject: text,
              mutating,
              unproven,
              verb: risk.verb,
              description: "interactive shell input",
              readonlyHost: hosts.isReadonly(host),
            });
            if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: "DENIED", outcome: decision.outcome });
            approvedOnce = decision.outcome === "allowed-once";
          }

          const onData = liveCommand === undefined || !submit ? undefined : event => liveCommand.output(event?.stream, event?.chunk);
          let result;
          if (guarded) {
            const verified = await targets.execute({ host, exec, sessionId, command: text, expectedChecksHash, expectedConnectionDigest, toolName: "remote_shell_send", description: "Guarded interactive shell command", onData });
            result = { viewport: verified.stdout, waitReason: "protocol_complete", sessionStatus: manager.describe(exec.agent, sessionId).status,
              truncated: verified.truncated, exitCode: verified.code, targetEvidence: verified.targetEvidence };
          } else {
            await dispatchInput({ agent: exec.agent, sessionId, host, expectedChecksHash, expectedConnectionDigest,
              text, submit, approvedOnce, signal: exec.signal });
            result = await manager.send({ agent: exec.agent, sessionId, text, submit, signal: exec.signal, ...(onData ? { onData } : {}) });
          }
          liveCommand?.note(`[${result.waitReason}]\n`);
          liveCommand?.end({
            code: Number.isInteger(result.exitCode) ? result.exitCode : result.sessionStatus?.kind === "exited" ? result.sessionStatus.exitCode ?? -1 : 0,
            durationMs: Date.now() - startedAt,
          });
          return {
            kind: "send",
            sessionId,
            host: described.host,
            viewport: result.viewport ?? "",
            waitReason: result.waitReason,
            sessionStatus: result.sessionStatus,
            truncated: result.truncated === true,
            ...(result.targetEvidence ? { targetEvidence: result.targetEvidence, exitCode: result.exitCode } : {}),
          };
        } catch (error) {
          liveCommand?.end({ error: submit ? describeError(error) : "Raw input request did not complete", durationMs: Date.now() - startedAt });
          throw error;
        }
      },
    }),
  );

  tools.push(
    defineTool({
      name: "remote_shell_read",
      description:
        "Read a bounded page from a persistent remote shell session's retained scrollback without sending anything. Offsets are newest-relative (0 = newest retained line). Use it to inspect output produced after a previous send settled or after a timeout.",
      parameters: {
        sessionId: {
          type: "string",
          required: true,
          description: "Session id returned by remote_shell_open or remote_shell_list.",
        },
        offset: {
          type: "integer",
          description: "Newest-relative line offset; 0 is the newest retained line.",
        },
        count: {
          type: "integer",
          description: "Number of lines to return; the backend caps it.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          {
            type: "text",
            text: bounded(
              [
                `scrollback ${value.sessionId}: lines ${value.lineBegin}-${value.lineEnd - 1} of ${value.totalLines}${value.truncated ? " (truncated)" : ""}`,
                value.text ?? "",
              ].join("\n"),
            ),
          },
        ],
      },
      presentCall(args) {
        return {
          card: "generic",
          kind: "read",
          title: `Read remote shell ${shortText(args.sessionId, "session", MAX_TITLE_CHARS)}`,
        };
      },
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const sessionId = requireText(args.sessionId, "sessionId");
        const page = manager.read({
          agent: exec.agent,
          sessionId,
          ...(args.offset === undefined ? {} : { offset: Number(args.offset) }),
          ...(args.count === undefined ? {} : { count: Number(args.count) }),
        });
        return {
          kind: "read",
          sessionId,
          text: page.text ?? "",
          totalLines: page.totalLines ?? 0,
          lineBegin: page.lineBegin ?? 0,
          lineEnd: page.lineEnd ?? 0,
          truncated: page.truncated === true,
        };
      },
    }),
  );

  tools.push(
    defineTool({
      name: "remote_shell_signal",
      description:
        "Deliver one POSIX signal to the foreground process group of a remote shell session (SIGINT, SIGTERM, SIGKILL, SIGTSTP, SIGHUP). Mutating: needs approval under auto/always, is denied under policy never and on read-only hosts. Use SIGINT to interrupt a running command instead of guessing.",
      parameters: {
        sessionId: {
          type: "string",
          required: true,
          description: "Session id returned by remote_shell_open or remote_shell_list.",
        },
        signal: {
          type: "string",
          required: true,
          enum: SIGNALS,
          description: "POSIX signal to deliver to the foreground process group.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          {
            type: "text",
            text: `delivered ${value.signal} to ${value.sessionId} (target process group ${value.targetPgid})`,
          },
        ],
      },
      presentCall(args) {
        return {
          card: "generic",
          kind: "delete",
          title: `Signal remote shell ${shortText(args.sessionId, "session", MAX_TITLE_CHARS)} (${String(args.signal ?? "")})`,
        };
      },
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const sessionId = requireText(args.sessionId, "sessionId");
        const signal = requireText(args.signal, "signal");
        if (!SIGNALS.includes(signal)) {
          throw new Error(`signal must be one of ${SIGNALS.join(", ")} (got ${JSON.stringify(signal)})`);
        }
        const { host } = await hostOf(exec.agent, sessionId);
        const liveCommand = beginLive(live, {
          sessionId: sessionIdOf(exec),
          tool: "remote_shell_signal",
          host: host.name,
          command: `${signal} ${sessionId}`,
          kind: "shell-signal",
        });
        try {
          const decision = await approval.authorize({
            toolName: "remote_shell_signal",
            exec,
            host,
            action: "execute",
            subject: `send ${signal} to the foreground process group`,
            mutating: true,
            verb: signal.toLowerCase(),
            description: "interrupt a remote shell command",
            readonlyHost: hosts.isReadonly(host),
          });
          if (!decision.allowed) throw new Error(decision.reason);
          const delivered = await manager.signal({ agent: exec.agent, sessionId, signal });
          liveCommand?.note(`${signal} delivered\n`);
          liveCommand?.end({ code: 0 });
          return { kind: "signal", sessionId, signal, ...delivered };
        } catch (error) {
          liveCommand?.end({ error: describeError(error) });
          throw error;
        }
      },
    }),
  );

  tools.push(
    defineTool({
      name: "remote_shell_close",
      description:
        "Close a persistent remote shell session and wait for its process tree to end. Track and close sessions you no longer need; sessions also end when the harness restarts.",
      parameters: {
        sessionId: {
          type: "string",
          required: true,
          description: "Session id returned by remote_shell_open or remote_shell_list.",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: `closed remote shell ${value.sessionId}` },
        ],
      },
      presentCall(args) {
        return {
          card: "generic",
          kind: "delete",
          title: `Close remote shell ${shortText(args.sessionId, "session", MAX_TITLE_CHARS)}`,
        };
      },
      async execute(args, exec) {
        throwIfAborted(exec.signal);
        const sessionId = requireText(args.sessionId, "sessionId");
        const liveCommand = beginLive(live, {
          sessionId: sessionIdOf(exec),
          tool: "remote_shell_close",
          host: "—",
          command: `close ${sessionId}`,
          kind: "shell-close",
        });
        try {
          const closed = await manager.close({ agent: exec.agent, sessionId, reason: "closed by the agent" });
          liveCommand?.end({ code: 0 });
          return { kind: "close", sessionId, closed: closed !== false };
        } catch (error) {
          liveCommand?.end({ error: describeError(error) });
          throw error;
        }
      },
    }),
  );

  tools.push(
    defineTool({
      name: "remote_shell_list",
      description:
        "List the persistent remote shell sessions owned by this agent (sessionId, host, status). Call it before closing or reusing a session you opened earlier.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.sessions.length === 0
                ? "no live remote shell sessions"
                : [
                    `${value.sessions.length} remote shell session${value.sessions.length === 1 ? "" : "s"}:`,
                    ...value.sessions.map(
                      (session) =>
                        `${session.sessionId}  ${session.host}  ${statusLine(session.status)}${session.name === undefined ? "" : `  (${session.name})`}`,
                    ),
                  ].join("\n"),
          },
        ],
      },
      presentCall() {
        return { card: "generic", kind: "read", title: "List remote shell sessions" };
      },
      async execute(_args, exec) {
        throwIfAborted(exec.signal);
        const sessions = manager.list(exec.agent).map((session) => ({
          sessionId: session.sessionId,
          host: session.host,
          ...(session.name === undefined ? {} : { name: session.name }),
          status: session.status,
        }));
        return { kind: "list", sessions };
      },
    }),
  );

  return tools;
}

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** @param {any} exec @returns {string|null} */
function sessionIdOf(exec) {
  const session = exec?.agent?.session ?? exec?.agent;
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** @param {any} live @param {object} input */
function beginLive(live, input) {
  if (live === undefined || live === null || typeof live.begin !== "function") return undefined;
  try {
    return live.begin(input);
  } catch {
    return undefined;
  }
}
