/**
 * dsh-remote — SSH remote-server operations for DeepSeek Harness.
 *
 * The plugin wires these pieces together:
 *   hosts   — ~/.ssh/config + configured + managed hosts (lib/host-store.js,
 *             lib/host-registry.js)
 *   ssh     — pooled ssh2 transport, auth, exec, SFTP (lib/ssh/**)
 *   review  — Crescent-style static command risk classification (lib/policy/**)
 *   gate    — approval policy over the DSH approval seam (lib/approval.js)
 *   tools   — nine model-facing tools, including safe restore (lib/tools.js)
 *   scripts — persistent agent shells + the interactive user terminal relay
 *             (lib/terminal/**)
 *
 * It registers the tools, contributes a static system-prompt section, serves
 * the browser management API, and disposes the connection pool, the shell
 * manager and the terminal relay with the plugin fiber.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { importRuntimePeer } from "./runtime-deps.js";
const { defineTool } = await importRuntimePeer("@deepseek-ai/dsh-tools");

import { API_PREFIX, createManagementApi } from "./api.js";
import { LIVE_PATH, createLiveStreamHandler } from "./live-stream.js";
import { createLiveHub } from "./live.js";
import { createAuditLog } from "./audit.js";
import { classifyAuditResult } from "./audit-result.js";
import { createApprovalGate } from "./approval.js";
import { Config, normalizeConfig } from "./config.js";
import { createHostRegistry } from "./host-registry.js";
import { createHostStore } from "./host-store.js";
import {
  PROMPT_ORDER,
  REMOTE_PROMPT_TEXT,
  REMOTE_SHELL_PROMPT_TEXT,
  SHELL_PROMPT_ORDER,
} from "./prompt.js";
import { createSshTransport } from "./ssh/transport.js";
import { createShellManager } from "./terminal/manager.js";
import { createTerminalRelay } from "./terminal/relay.js";
import { createShellTools } from "./terminal/tools.js";
import { createTools } from "./tools.js";
import { createTargetController } from "./target-controller.js";
import { createTargetCheckTool } from "./target-tools.js";
import { createTargetRegistry } from "./target-registry.js";
import { createTargetApi } from "./target-api.js";

export const name = "dsh-remote";

export { Config };

/**
 * Services this plugin needs before it activates. `approval` is optional and is
 * resolved per call through `ctx.get("approval")`, so a composition without the
 * seam still loads and fails closed for mutating actions.
 */
export const inject = ["tools", "systemPrompt"];

/** Default idle close for pooled SSH connections. */
const IDLE_MS = 60_000;

/**
 * Resolve the harness home. `$DSH_HOME` is set by the app and its CLI; fall back
 * to `~/.dsh` for plain Node use (tests, scripts).
 *
 * @returns {string}
 */
function harnessHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".dsh");
}

/**
 * Managed-host registry location: the configured path, or
 * `$DSH_HOME/remote/hosts.json` when the config leaves it empty (the default).
 *
 * @param {{ hostRegistryPath?: string }} config
 * @returns {string}
 */
function hostRegistryPath(config) {
  const configured = typeof config.hostRegistryPath === "string" ? config.hostRegistryPath.trim() : "";
  return configured.length > 0 ? configured : join(harnessHome(), "remote", "hosts.json");
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  // The loader validates config against `Config`; normalization here also covers
  // direct (test) callers and future schema drift. A bad config fails loudly at
  // load rather than on the first remote command.
  const config = normalizeConfig(rawConfig);
  const logger = ctx?.logger;

  const transport = createSshTransport({
    connectTimeoutMs: config.connectTimeoutMs,
    idleMs: IDLE_MS,
    knownHostsPolicy: config.knownHostsPolicy,
    knownHostsPath: join(harnessHome(), "remote", "known-hosts.json"),
    logger,
  });

  // Managed host registry (v0.5): persisted CRUD over
  // $DSH_HOME/remote/hosts.json. The store loads the registry lazily on host
  // discovery; the management API calls `store.invalidate()` after mutations.
  const registry = createHostRegistry({ filePath: hostRegistryPath(config), logger });

  const hosts = createHostStore({ config, logger, registry });
  // Live terminal mirror: one hub per plugin instance feeds the SSE route and
  // receives start/output/end events from remote_exec and the shell tools.
  const live = config.liveTerminal === false ? undefined : createLiveHub({ logger });
  const approval = createApprovalGate({ ctx, config, logger });
  const audit = createAuditLog({
    filePath: join(harnessHome(), "remote", "audit.jsonl"),
    limit: config.auditLimit,
    maxBytes: config.auditMaxBytes,
    retentionDays: config.auditRetentionDays,
    logger,
  });
  // Best-effort restore of the persisted tail; never blocks plugin activation.
  audit.load().catch((error) => {
    logger?.warn?.(`dsh-remote: audit history load failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Interactive user terminal (v0.5). The relay owns one SSH PTY per
  // (conversation, host), reuses it across native-terminal attachments and
  // serves DSH's own terminal through a local socket. Creation/start is
  // best-effort: a failure only warns and disables the surface, it never breaks
  // plugin load. The API talks to this facade so it can report/enforce
  // availability; the relay itself owns its socket and session lifecycle.
  const userTerminalRequested =
    config.userTerminal === true && config.terminalEnabled === true;
  /** @type {any} */
  let terminalRelay;
  /** @type {any} */
  let terminal;
  if (userTerminalRequested) {
    try {
      terminalRelay = createTerminalRelay({ transport, hosts, config, audit, logger });
      terminal = {
        enabled: true,
        available: false,
        get socketPath() {
          return typeof terminalRelay?.socketPath === "string" ? terminalRelay.socketPath : null;
        },
        async start() {
          try {
            await terminalRelay.start();
            terminal.available = true;
            return true;
          } catch (error) {
            terminal.available = false;
            throw error;
          }
        },
        open(options) {
          return terminalRelay.open(options);
        },
        list(options) {
          return terminalRelay.list(options);
        },
        close(sessionKey) {
          return terminalRelay.close(sessionKey);
        },
      };
      // Never await here: plugin activation must not depend on the socket server.
      void terminal.start().catch((error) => {
        logger?.warn?.(
          `dsh-remote: interactive terminal disabled: relay start failed: ${errorMessage(error)}`,
        );
      });
    } catch (error) {
      logger?.warn?.(
        `dsh-remote: interactive terminal disabled: relay creation failed: ${errorMessage(error)}`,
      );
      terminalRelay = undefined;
      terminal = undefined;
    }
  }

  /**
   * Session working directory, used to resolve transfer local paths. Kept
   * best-effort: a composition without the working-directory service still
   * supports remote work, and transfers fall back to the process cwd.
   *
   * @param {import("@deepseek-ai/dsh-tools").ToolExecution} exec
   * @returns {Promise<string>}
   */
  const cwdOf = async (exec) => {
    try {
      const workingDirectory = ctx?.get?.("workingDirectory");
      if (workingDirectory !== undefined && workingDirectory !== null && exec.agent !== undefined) {
        return await workingDirectory.ensure(exec.agent, exec.signal);
      }
    } catch {
      // fall through to the process cwd
    }
    return process.cwd();
  };

  // Target checks must use the actual owned PTY, never the shortcut entrance.
  const shellManager = config.terminalEnabled === true
    ? createShellManager({ ctx, transport, config, relay: terminalRelay, logger }) : undefined;
  const targetRegistry = createTargetRegistry({ root: join(harnessHome(), "remote", "target-checks") });
  const targets = createTargetController({ config, transport, hosts, approval, manager: shellManager, live,
    managedChecks: host => targetRegistry.managedChecks(host), refreshManaged: () => targetRegistry.refresh() });
  const tools = createTools({ defineTool, config, transport, hosts, approval, cwdOf, live, logger, targets,
    backupRoot: join(harnessHome(), "remote", "backups"),
  });
  const shellTools = shellManager === undefined ? []
    : createShellTools({ defineTool, config, manager: shellManager, approval, hosts, live, logger, targets });
  const targetTools = [createTargetCheckTool({ defineTool, hosts, targets })];
  const targetApi = createTargetApi({ targetRegistry, hosts, targets });

  ctx.effect(
    () => () => {
      try {
        transport.dispose();
      } catch (error) {
        logger?.warn?.(`dsh-remote: transport disposal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      audit.dispose().catch(() => undefined);
    },
    "dsh-remote: ssh transport",
  );

  // The interactive terminal relay owns a local socket server and live SSH
  // PTYs; tear it down with the plugin (quiescent, best-effort).
  if (terminalRelay !== undefined) {
    const relay = terminalRelay;
    ctx.effect(
      () => () => {
        try {
          relay.dispose().catch((error) => {
            logger?.warn?.(`dsh-remote: user terminal relay disposal failed: ${errorMessage(error)}`);
          });
        } catch (error) {
          logger?.warn?.(`dsh-remote: user terminal relay disposal failed: ${errorMessage(error)}`);
        }
      },
      "dsh-remote: user terminal relay",
    );
  }

  const auditedTools = [...tools, ...shellTools, ...targetTools].map((tool) =>
    withAudit(tool, { audit, approval, manager: shellManager }),
  );
  for (const tool of auditedTools) ctx.tools.register(tool);

  // The browser management page needs a Host HTTP endpoint. It is registered
  // only where a web server exists (never in headless CLI runs) and every
  // request goes through the Host connection fence inside the handler.
  if (config.managementApi || config.liveTerminal) {
    ctx.inject(["webServer"], (scope) => {
      if (config.managementApi) {
        const handler = createManagementApi({
          ctx,
          config,
          hosts,
          transport,
          manager: shellManager,
          audit,
          hub: live,
          registry,
          relay: terminal,
          hostStore: hosts,
          debugLogPath: join(harnessHome(), "remote", "terminal-debug.log"),
          logger,
          targetApi,
        });
        scope.effect(
          () => scope.webServer.register({ kind: "prefix", path: API_PREFIX, handler }),
          "dsh-remote: management API",
        );
      }
      if (config.liveTerminal && live !== undefined) {
        const stream = createLiveStreamHandler({ ctx, hub: live, logger });
        scope.effect(
          () => scope.webServer.register({ kind: "exact", path: LIVE_PATH, handler: stream }),
          "dsh-remote: live terminal stream",
        );
      }
    });
  }

  if (config.promptGuidance) {
    ctx.systemPrompt.section({
      name: "tool:remote",
      order: PROMPT_ORDER,
      text: REMOTE_PROMPT_TEXT,
    });
    if (shellTools.length > 0) {
      ctx.systemPrompt.section({
        name: "tool:remote-shell",
        order: SHELL_PROMPT_ORDER,
        text: REMOTE_SHELL_PROMPT_TEXT,
      });
    }
  }
}

/**
 * Per-tool audit metadata. `host` prefers the argument the model supplied and
 * falls back to the shell session's host for session-scoped tools.
 *
 * @param {any} tool
 * @param {any} args
 * @param {any} exec
 * @param {any} deps
 * @returns {{host: string, action: string, risk: string, detail: string}}
 */
function auditMeta(tool, args, exec, deps) {
  const name = String(tool.name ?? "");
  const rawHost = typeof args?.host === "string" ? args.host : undefined;
  let host = rawHost ?? "—";
  if (rawHost === undefined && typeof args?.sessionId === "string" && deps.manager !== undefined) {
    try {
      host = deps.manager.describe(exec.agent, args.sessionId).host;
    } catch {
      host = "—";
    }
  }
  const path = typeof args?.path === "string" ? args.path : undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  const text = typeof args?.text === "string" ? args.text : undefined;
  const submit = args?.submit ?? true;

  switch (name) {
    case "remote_hosts":
      return { host: "—", action: "hosts", risk: "", detail: args?.all === true ? "all hosts" : "allowed hosts" };
    case "remote_probe":
      return { host, action: "probe", risk: "read", detail: host };
    case "remote_exec": {
      const risk = deps.approval.assessCommand(command ?? "");
      return { host, action: "exec", risk: risk.level, detail: command ?? "" };
    }
    case "remote_read":
      return { host, action: "read", risk: "read", detail: path ?? "" };
    case "remote_list":
      return { host, action: "list", risk: "read", detail: path ?? "" };
    case "remote_write":
      return { host, action: "write", risk: "write", detail: path ?? "" };
    case "remote_edit":
      return { host, action: "edit", risk: "write", detail: path ?? "" };
    case "remote_restore":
      return { host, action: "restore", risk: "write", detail: `backup ${String(args?.backup_id ?? "")}` };
    case "remote_transfer":
      return {
        host,
        action: `transfer ${String(args?.direction ?? "")}`.trim(),
        risk: "write",
        detail: `${args?.local_path ?? ""} -> ${args?.remote_path ?? ""}`,
      };
    case "remote_shell_open":
      return { host, action: "shell open", risk: "execute", detail: host };
    case "remote_shell_send": {
      if (!submit || /[\x00-\x1f\x7f]/u.test(text ?? "")) return { host, action: "shell send", risk: "input", detail: "[raw input omitted]" };
      const risk = deps.approval.assessCommand(text ?? "");
      return { host, action: "shell send", risk: risk.level, detail: text ?? "" };
    }
    case "remote_shell_read":
      return { host, action: "shell read", risk: "read", detail: args?.sessionId ?? "" };
    case "remote_shell_signal":
      return { host, action: "shell signal", risk: "write", detail: `${args?.signal ?? ""} ${args?.sessionId ?? ""}`.trim() };
    case "remote_shell_close":
      return { host, action: "shell close", risk: "", detail: args?.sessionId ?? "" };
    case "remote_shell_list":
      return { host: "—", action: "shell list", risk: "", detail: "" };
    default:
      if (name === "remote_target_check") return { host, action: "target check", risk: args?.reset_input ? "write" : "read", detail: args?.reset_input ? "explicit PTY input reset and configured checks" : "configured target facts" };
      return { host, action: name, risk: "", detail: "" };
  }
}

/** Current SDK Agent.id is session-backed; Agent.session is its durable log.
 * Only identities are retained, never arbitrary Agent/scope objects.
 */
function auditCorrelation(exec) {
  const stringId = (value) => typeof value === "string" && value.trim() ? value : undefined;
  const agentId = stringId(exec?.agent?.id);
  const sessionId = stringId(exec?.agent?.session?.id) ?? agentId;
  const callId = stringId(exec?.callId);
  const rootCallId = stringId(exec?.rootCallId);
  return { operationId: randomUUID(),
    ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}),
    ...(callId ? { callId } : {}), ...(rootCallId ? { rootCallId } : {}),
  };
}

/**
 * Wrap one ToolDefinition so every model-facing call is audited. The wrapper
 * preserves the definition's schema/render/presentation fields and only
 * extends `execute`.
 *
 * @param {any} tool
 * @param {{ audit: any, approval: any, manager?: any }} deps
 * @returns {any}
 */
function withAudit(tool, deps) {
  return {
    ...tool,
    async execute(args, exec) {
      const started = Date.now();
      const correlation = auditCorrelation(exec);
      let meta = { host: "—", action: String(tool.name ?? ""), risk: "", detail: "" };
      try {
        meta = auditMeta(tool, args, exec, deps);
      } catch {
        // metadata must never break the call
      }
      const record = (value, error) => {
        // The audit store redacts metadata uniformly. Classifier copies only
        // fixed summaries and explicit recovery facts, never outputs or Diff.
        try {
          deps.audit.record({ ...meta, ...correlation, tool: tool.name,
            ...classifyAuditResult(tool.name, value, error),
            ...(typeof value?.timedOut === "boolean" ? { timedOut: value.timedOut } : {}),
            durationMs: Date.now() - started,
          });
        } catch {
          // Audit failure must never replace a tool result or trigger replay.
        }
      };
      try {
        const value = await tool.execute(args, exec);
        // Successful tools return the resolved logical host, which may differ
        // from the supplied id/case alias used to look it up.
        if (typeof value?.host === "string") meta.host = value.host;
        record(value);
        return value;
      } catch (error) {
        record(undefined, error);
        throw error;
      }
    },
  };
}
