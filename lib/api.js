/**
 * Host HTTP API behind the browser "Remote Ops" management page.
 *
 * Registered by `lib/index.js` on the DSH web server under
 * `/dsh-remote/api` (prefix route). Every request must pass the Host connection
 * fence (the same Host/Origin + browser-cookie check `/api` uses) and is
 * answered from the plugin's own services:
 *
 *   POST { method: "overview" }                        -> hosts / sessions / audit / terminal
 *   POST { method: "host.test", name }                 -> read-only connectivity probe
 *   POST { method: "host.create", host }               -> persist a managed host
 *   POST { method: "host.update", name, host }         -> update a managed host
 *   POST { method: "host.delete", name }               -> remove a managed host
 *   POST { method: "audit.list", host?, limit?, offset?, full? } -> audit page
 *   POST { method: "terminal.open", name, sessionId? } -> open/reuse a user SSH PTY
 *   POST { method: "terminal.list", sessionId? }       -> user terminal sessions
 *   POST { method: "terminal.close", sessionKey }      -> close a user terminal session
 *   POST { method: "terminal.trace", stage, sessionId?, detail? } -> bounded client trace
 *   POST { method: "session.read", sessionId, offset?, count? } -> scrollback page
 *   POST { method: "session.close", sessionId }        -> close a shell session
 *   POST { method: "audit.clear" }                     -> clear the audit trail
 *   POST { method: "live.emit", ... }                  -> dev-only live event injector
 *
 * Answers are `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.
 * The route is never registered without a web server (headless CLI runs have no
 * management page), and it is fenced fail-closed when a connection service is
 * mounted.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ApiError,
  MAX_BODY_BYTES,
  appendBoundedTraceLine,
  authHintFor,
  fail,
  formatTarget,
  isManaged,
  mapManagerError,
  mapTerminalError,
  messageOf,
  optionalAuditFull,
  optionalAuditHost,
  optionalAuditInteger,
  optionalPositiveInt,
  optionalTerminalSessionId,
  readJsonBody,
  remoteHostOf,
  requireHostInput,
  requireHostName,
  requireString,
  requireTerminalArg,
  safeFlag,
  writeJson,
} from "./api-helpers.js";

const requirePackage = createRequire(import.meta.url);
const VERSION = (() => {
  try {
    return requirePackage("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Prefix registered on the DSH web server. */
export const API_PREFIX = "/dsh-remote/api";
/** Bound for a management connection test. */
const HOST_TEST_TIMEOUT_MS = 12_000;
const HOST_TEST_MAX_BYTES = 8_192;
/** Page cap for `audit.list` (the audit ring is bounded anyway). */
const AUDIT_MAX_LIMIT = 1_000;
/** Number of audit entries the lightweight `overview` carries (v0.5.1). */
const OVERVIEW_AUDIT_LIMIT = 20;
/** Stage shape accepted by `terminal.trace` (client diagnostics). */
const TRACE_STAGE_RE = /^[\w.:-]{1,64}$/u;
/** Maximum accepted `terminal.trace` detail length. */
const TRACE_DETAIL_MAX_CHARS = 2_000;

/**
 * @param {object} deps
 * @param {object} deps.ctx Cordis context (for the optional connection fence).
 * @param {object} deps.config Normalized plugin config.
 * @param {object} deps.hosts Host store (`lib/host-store.js`).
 * @param {object} deps.transport SSH transport.
 * @param {object} [deps.manager] Shell manager (when terminal support is enabled).
 * @param {object} deps.audit Audit log (`lib/audit.js`).
 * @param {object} [deps.hub] Live command hub (`lib/live.js`), for the dev injector.
 * @param {object} [deps.registry] Managed host registry (`lib/host-registry.js`).
 * @param {object} [deps.relay] User terminal relay or a facade over it
 *   (`{ start?, open, list, close, socketPath, available? }`).
 * @param {object} [deps.hostStore] Host store exposing `invalidate()`; defaults
 *   to `hosts` (same object in the plugin wiring).
 * @param {string} [deps.debugLogPath] bounded client-trace file
 *   (`$DSH_HOME/remote/terminal-debug.log`); derived from `$DSH_HOME` when omitted.
 * @param {{ warn?: (m: string) => void }} [deps.logger]
 * @param {() => string} [deps.workspaceRoot] Session-independent project dir hint.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createManagementApi({
  ctx,
  config,
  hosts,
  transport,
  manager,
  audit,
  hub,
  registry,
  relay,
  hostStore,
  debugLogPath,
  logger,
}) {
  // The host store is the object that owns the discovery cache. Older
  // compositions/tests pass only `hosts`; both are accepted.
  const store = hostStore ?? hosts;
  const traceLogPath =
    typeof debugLogPath === "string" && debugLogPath.trim().length > 0
      ? debugLogPath.trim()
      : join(
          typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim().length > 0
            ? process.env.DSH_HOME.trim()
            : join(homedir(), ".dsh"),
          "remote",
          "terminal-debug.log",
        );
  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // ignore
    }
  };

  async function dispatch(body, signal) {
    const method = typeof body?.method === "string" ? body.method : "";
    switch (method) {
      case "overview":
        return overview();
      case "host.test":
        return hostTest(requireString(body.name, "name"));
      case "auth.password":
        return authenticatePassword(body, signal);
      case "host.create":
        return hostCreate(body);
      case "host.update":
        return hostUpdate(body);
      case "host.delete":
        return hostDelete(body);
      case "audit.list":
        return auditList(body);
      case "terminal.open":
        return terminalOpen(body, signal);
      case "terminal.list":
        return terminalList(body);
      case "terminal.close":
        return terminalClose(body);
      case "terminal.trace":
        return terminalTrace(body);
      case "session.read":
        return sessionRead(
          requireString(body.sessionId, "sessionId"),
          optionalPositiveInt(body.offset, "offset"),
          optionalPositiveInt(body.count, "count"),
        );
      case "session.close":
        return sessionClose(requireString(body.sessionId, "sessionId"));
      case "audit.clear":
        return audit.clear();
      case "live.emit":
        return emitLiveDev(body);
      default:
        throw new ApiError("UNKNOWN_METHOD", `unknown management method ${JSON.stringify(method)}`, 404);
    }
  }

  async function overview() {
    let listed = [];
    try {
      listed = await hosts.list({ refresh: true });
    } catch (error) {
      warn(`dsh-remote: management overview could not load hosts: ${messageOf(error)}`);
    }
    const hostViews = listed.map((host) => hostView(host));
    const sessions = typeof manager?.adminList === "function" ? manager.adminList() : [];
    return {
      version: VERSION,
      policy: config.policy,
      allowHosts: config.allowHosts,
      readonlyHosts: config.readonlyHosts,
      sshConfigPath: config.sshConfigPath,
      includeSshConfig: config.includeSshConfig,
      terminalEnabled: config.terminalEnabled,
      counts: { hosts: hostViews.length, sessions: sessions.length, audit: audit.size },
      hosts: hostViews,
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        host: session.host,
        name: session.name ?? null,
        status: session.status,
        createdAt: session.createdAt ?? null,
      })),
      // v0.5.1: the overview only carries the newest 20 operations; the audit
      // modal/export uses `audit.list` with its own (full) page.
      audit: audit.list({ limit: OVERVIEW_AUDIT_LIMIT }),
      live: {
        enabled: config.liveTerminal !== false,
        autoOpen: config.autoOpenLiveTerminal !== false,
        devEvents: config.devLiveEvents === true,
      },
      terminal: await terminalOverview(),
    };
  }

  /**
   * One HostView for the browser: the resolved connection coordinates plus the
   * policy flags and the v0.5 `managed` marker (editable/deletable on the page).
   *
   * @param {any} host
   * @returns {object}
   */
  function hostView(host) {
    return {
      name: host.name,
      host: host.host,
      target: formatTarget(host),
      port: host.port ?? 22,
      username: host.username ?? null,
      source: host.source,
      managed: isManaged(host),
      description: host.description ?? null,
      tags: host.tags ?? [],
      // Non-secret connection references, exposed so the host edit form can
      // prefill them (the registry update is a full replace). Never values.
      identityFile: typeof host.identityFile === "string" ? host.identityFile : null,
      passwordEnv: typeof host.passwordEnv === "string" ? host.passwordEnv : null,
      passphraseEnv: typeof host.passphraseEnv === "string" ? host.passphraseEnv : null,
      proxyJump: Array.isArray(host.proxyJump) ? host.proxyJump : [],
      readonly: safeFlag(() => hosts.isReadonly(host), false),
      allowed: safeFlag(() => hosts.isAllowed(host), true),
      authHint: authHintFor(host),
      ...(host.viaHost ? { viaHost: host.viaHost, actions: host.actions?.map((action) => ({ ...action })) ?? [], terminalOnly: true } : {}),
    };
  }

  /**
   * v0.5 terminal surface for the panel: whether user terminals are enabled and
   * the relay is listening, the socket the bridge connects to, and the live
   * session views. The relay start is retried here (idempotent) so the first
   * page load already sees a listening terminal when the socket comes up late.
   *
   * @returns {Promise<{enabled: boolean, available: boolean, socketPath: string | null, sessions: object[]}>}
   */
  async function terminalOverview() {
    const enabled = config.userTerminal !== false && config.terminalEnabled !== false;
    if (relay === undefined || relay === null) {
      return { enabled, available: false, socketPath: null, sessions: [] };
    }
    if (relay.available === false && typeof relay.start === "function") {
      try {
        await relay.start();
      } catch (error) {
        warn(`dsh-remote: interactive terminal is unavailable: ${messageOf(error)}`);
      }
    }
    let sessions = [];
    try {
      const listed = relay.list({});
      sessions = Array.isArray(listed) ? listed : [];
    } catch (error) {
      warn(`dsh-remote: could not list user terminal sessions: ${messageOf(error)}`);
    }
    return {
      enabled,
      available: relay.available !== false,
      socketPath: typeof relay.socketPath === "string" ? relay.socketPath : null,
      sessions,
    };
  }

  /**
   * Development-only live event injector used by the browser verification loop.
   * It is reachable only when `devLiveEvents: true` is explicitly configured.
   *
   * @param {any} body
   */
  async function emitLiveDev(body) {
    if (hub === undefined || hub === null) {
      throw new ApiError("METHOD_UNAVAILABLE", "the live terminal is disabled in this composition", 409);
    }
    if (config.devLiveEvents !== true) {
      throw new ApiError("DEV_EVENTS_DISABLED", "live.emit is only available with devLiveEvents: true", 403);
    }
    const command = hub.begin({
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      tool: typeof body.tool === "string" ? body.tool : "remote_exec",
      host: typeof body.host === "string" ? body.host : "testbox",
      command: typeof body.command === "string" ? body.command : "echo dev-live-event",
      kind: typeof body.kind === "string" ? body.kind : "exec",
    });
    const lines = Array.isArray(body.lines) ? body.lines : ["dev live output line 1", "dev live output line 2"];
    for (const line of lines) {
      command.output("stdout", `${String(line)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    command.end({ code: typeof body.code === "number" ? body.code : 0, durationMs: 900 });
    return { id: command.id, emitted: lines.length };
  }

  async function hostTest(name) {
    let host;
    try {
      host = await hosts.find(name);
    } catch (error) {
      throw new ApiError("UNKNOWN_HOST", messageOf(error), 404);
    }
    if (!hosts.isAllowed(host)) {
      throw new ApiError("HOST_NOT_ALLOWED", `Host ${host.name} is not allowed by the allowHosts policy`, 403);
    }
    if (host.viaHost) throw new ApiError("TERMINAL_ONLY_HOST", `Host ${host.name} is a terminal-only cluster shortcut. Connect its shared terminal to verify login; a probe would only test ${host.viaHost}.`, 409);
    const signal = AbortSignal.timeout(HOST_TEST_TIMEOUT_MS);
    let reachability;
    try {
      reachability = await transport.test(host, { signal, timeoutMs: HOST_TEST_TIMEOUT_MS });
    } catch (error) {
      reachability = { ok: false, latencyMs: 0, error: messageOf(error) };
    }
    if (reachability.ok !== true) {
      return { name: host.name, ok: false, latencyMs: reachability.latencyMs ?? 0, error: reachability.error ?? "connection failed" };
    }
    try {
      const result = await transport.exec(host, {
        command: "uname -srm 2>/dev/null; hostname",
        timeoutMs: HOST_TEST_TIMEOUT_MS,
        maxBytes: HOST_TEST_MAX_BYTES,
        signal,
      });
      return {
        name: host.name,
        ok: result.code === 0,
        latencyMs: reachability.latencyMs ?? 0,
        output: String(result.stdout ?? "").trim(),
      };
    } catch (error) {
      return { name: host.name, ok: false, latencyMs: reachability.latencyMs ?? 0, error: messageOf(error) };
    }
  }

  // --- v0.5 managed hosts (host.create / host.update / host.delete) ------

  /** @returns {any} */
  function requireRegistry() {
    if (registry === undefined || registry === null) {
      throw fail("HOST_NOT_MANAGED", "managed hosts are not available in this composition");
    }
    return registry;
  }

  async function hostCreate(body) {
    const managed = requireRegistry();
    const input = requireHostInput(body, "host.create");
    let record;
    try {
      record = await managed.create(input);
    } catch (error) {
      throw await mapHostError(error, input?.name);
    }
    return { host: await hostViewAfterMutation(record) };
  }

  async function hostUpdate(body) {
    const managed = requireRegistry();
    const name = requireHostName(body?.name);
    const input = requireHostInput(body, "host.update");
    let record;
    try {
      record = await managed.update(name, input);
    } catch (error) {
      throw await mapHostError(error, name);
    }
    return { host: await hostViewAfterMutation(record) };
  }

  async function hostDelete(body) {
    const managed = requireRegistry();
    const name = requireHostName(body?.name);
    try {
      const deleted = await managed.delete(name);
      if (deleted === false) {
        const error = new Error(`managed host ${JSON.stringify(name)} does not exist`);
        error.code = "HOST_NOT_FOUND";
        throw error;
      }
    } catch (error) {
      throw await mapHostError(error, name);
    }
    await reloadHosts();
    return { deleted: true };
  }

  /**
   * Build the reply HostView from the merged discovery list after a registry
   * mutation, so the page sees exactly what a tool call sees (source/flags).
   * Falls back to the raw registry record if discovery hiccups.
   *
   * @param {any} record
   */
  async function hostViewAfterMutation(record) {
    const name = String(record?.name ?? "");
    const listed = await reloadHosts();
    const merged = listed.find((host) => String(host.name).toLowerCase() === name.toLowerCase());
    return hostView(merged ?? remoteHostOf(record));
  }

  /** Invalidate the host-store cache so the next list/find reloads the registry. */
  async function reloadHosts() {
    try {
      if (typeof store?.invalidate === "function") store.invalidate();
    } catch (error) {
      warn(`dsh-remote: host cache invalidation failed: ${messageOf(error)}`);
    }
    try {
      return await hosts.list({ refresh: true });
    } catch (error) {
      warn(`dsh-remote: host reload after a registry mutation failed: ${messageOf(error)}`);
      return [];
    }
  }

  /**
   * Map a registry error onto the documented host API error codes. A name that
   * exists in the merged host list but is not registry-managed is reported as
   * HOST_NOT_MANAGED rather than HOST_NOT_FOUND (the page can then explain that
   * ~/.ssh/config hosts are read-only here).
   *
   * @param {unknown} error
   * @param {unknown} name
   * @returns {Promise<ApiError>}
   */
  async function mapHostError(error, name) {
    if (error instanceof ApiError) return error;
    const code = typeof (/** @type {any} */ (error)?.code) === "string" ? /** @type {any} */ (error).code : "";
    if (code === "HOST_EXISTS") return fail("HOST_EXISTS", messageOf(error));
    if (code === "HOST_DISALLOWED") return fail("HOST_DISALLOWED", messageOf(error));
    if (code === "HOST_NOT_MANAGED") return fail("HOST_NOT_MANAGED", messageOf(error));
    if (code === "HOST_NOT_FOUND" || code === "UNKNOWN_HOST") {
      const existing = await findHostQuietly(name);
      if (existing !== undefined && !isManaged(existing)) {
        return fail(
          "HOST_NOT_MANAGED",
          `host ${JSON.stringify(String(name ?? ""))} is not managed by dsh-remote; ` +
            "only hosts added through the host manager can be edited or deleted",
        );
      }
      return fail("HOST_NOT_FOUND", messageOf(error));
    }
    return fail("HOST_INVALID", messageOf(error));
  }

  /** @param {unknown} name */
  async function findHostQuietly(name) {
    if (typeof name !== "string" || name.trim() === "") return undefined;
    try {
      return await hosts.find(name);
    } catch {
      return undefined;
    }
  }

  // --- v0.5 host-filtered audit (audit.list) ------------------------------

  async function auditList(body) {
    const host = optionalAuditHost(body?.host);
    const limit = optionalAuditInteger(body?.limit, "limit", 1, AUDIT_MAX_LIMIT);
    const offset = optionalAuditInteger(body?.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    const full = optionalAuditFull(body?.full);
    const filter = host === undefined ? {} : { host };
    let entries;
    let total;
    try {
      entries = audit.list({
        ...filter,
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
        ...(full === undefined ? {} : { full }),
      });
      total =
        typeof audit.count === "function"
          ? audit.count(filter)
          : Array.isArray(entries)
            ? entries.length
            : 0;
    } catch (error) {
      throw fail("AUDIT_INVALID", messageOf(error));
    }
    return {
      host: host ?? null,
      total: Number.isSafeInteger(total) && total >= 0 ? total : 0,
      entries: Array.isArray(entries) ? entries : [],
    };
  }

  // --- v0.5 interactive user terminal (terminal.*) ------------------------

  /** @returns {any} */
  function requireTerminal() {
    if (relay === undefined || relay === null) {
      throw fail("TERMINAL_DISABLED", "the interactive user terminal is not enabled in this composition");
    }
    return relay;
  }

  /**
   * The relay is started best-effort by the plugin wiring; a retry here recovers
   * from a transient socket error without ever breaking the request path.
   *
   * @param {any} terminal
   */
  async function ensureRelayStarted(terminal) {
    if (typeof terminal.start !== "function") return;
    try {
      await terminal.start();
    } catch (error) {
      throw fail("TERMINAL_ERROR", `the terminal relay could not start: ${messageOf(error)}`);
    }
  }

  // Human credential entry only; no Agent tool, audit payload, or disk storage.
  async function authenticatePassword(body, signal) {
    const name = requireHostName(body?.name);
    if (typeof body?.password !== "string" || body.password.length === 0 || body.password.length > 4096) {
      throw new ApiError("INVALID_ARGUMENT", "password must be a non-empty string of at most 4096 characters");
    }
    const host = await findHostQuietly(name);
    if (!host) throw fail("HOST_NOT_FOUND", "host not found");
    if (!hosts.isAllowed(host)) throw fail("HOST_DISALLOWED", "host is not allowed by allowHosts");
    if (typeof transport?.authenticatePassword !== "function") {
      throw fail("AUTH", "password login is not available in this composition");
    }
    try {
      await transport.authenticatePassword(host, body.password, { signal });
      return { authenticated: true, name: host.name };
    } catch (error) {
      // Never serialize a server-controlled message on a secret-bearing request.
      if (error?.code === "HOST_KEY") throw fail("HOST_KEY", "SSH host key verification failed; check the trusted host key before retrying");
      throw fail("AUTH", "SSH password authentication failed; verify the password or authentication method");
    } finally {
      delete body.password;
    }
  }

  async function terminalOpen(body, signal) {
    const terminal = requireTerminal();
    const name = requireTerminalArg(body?.name, "name");
    const sessionId = optionalTerminalSessionId(body?.sessionId);
    await ensureRelayStarted(terminal);
    let opened;
    try {
      opened = await terminal.open({
        hostName: name,
        ...(signal ? { signal } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    } catch (error) {
      throw mapTerminalError(error);
    }
    if (opened === null || typeof opened !== "object" || opened.session === undefined) {
      throw fail("TERMINAL_ERROR", "the terminal relay did not return a session");
    }
    return { shell: opened.shell, session: opened.session };
  }

  async function terminalList(body) {
    const terminal = requireTerminal();
    const sessionId = optionalTerminalSessionId(body?.sessionId);
    let sessions;
    try {
      sessions = terminal.list(sessionId === undefined ? {} : { sessionId });
    } catch (error) {
      throw mapTerminalError(error);
    }
    return { sessions: Array.isArray(sessions) ? sessions : [] };
  }

  /**
   * `terminal.trace` — fire-and-forget client diagnostics. The client records
   * the tab/write/attach/timeout stages so a failed attach is diagnosable from
   * disk; the line never enters the audit ring and I/O never fails the caller.
   *
   * @param {any} body
   * @returns {{ ok: true }}
   */
  function terminalTrace(body) {
    const stage = typeof body?.stage === "string" ? body.stage : "";
    if (!TRACE_STAGE_RE.test(stage)) {
      throw new ApiError(
        "INVALID_ARGUMENT",
        "stage must be 1-64 characters of letters, digits, '_', '.', ':' or '-'",
      );
    }
    const rawDetail = body?.detail;
    const detail = rawDetail === undefined || rawDetail === null ? "" : String(rawDetail);
    if (detail.length > TRACE_DETAIL_MAX_CHARS) {
      throw new ApiError("INVALID_ARGUMENT", `detail must be at most ${TRACE_DETAIL_MAX_CHARS} characters`);
    }
    const sessionId = optionalTerminalSessionId(body?.sessionId);
    // Best effort: a read-only/absent debug path never fails the action.
    appendBoundedTraceLine(
      traceLogPath,
      JSON.stringify({ time: Date.now(), stage, sessionId: sessionId ?? null, detail }),
    );
    return { ok: true };
  }

  async function terminalClose(body) {
    const terminal = requireTerminal();
    const sessionKey = requireTerminalArg(body?.sessionKey, "sessionKey");
    let closed;
    try {
      closed = await terminal.close(sessionKey);
    } catch (error) {
      throw mapTerminalError(error);
    }
    if (closed === false) {
      throw fail("TERMINAL_NOT_FOUND", `no user terminal session ${JSON.stringify(sessionKey)}`);
    }
    return { closed: true };
  }

  async function sessionRead(sessionId, offset, count) {
    if (typeof manager?.adminRead !== "function") {
      throw new ApiError("METHOD_UNAVAILABLE", "remote shell sessions are not enabled in this composition", 409);
    }
    try {
      const page = manager.adminRead({ sessionId, ...(offset === undefined ? {} : { offset }), ...(count === undefined ? {} : { count }) });
      const session = typeof manager.adminGet === "function" ? manager.adminGet(sessionId) : undefined;
      return {
        sessionId,
        host: session?.host ?? page.host ?? "—",
        status: session?.status ?? null,
        text: page.text ?? "",
        totalLines: page.totalLines ?? 0,
        lineBegin: page.lineBegin ?? 0,
        lineEnd: page.lineEnd ?? 0,
        truncated: page.truncated === true,
      };
    } catch (error) {
      throw mapManagerError(error);
    }
  }

  async function sessionClose(sessionId) {
    if (typeof manager?.adminClose !== "function") {
      throw new ApiError("METHOD_UNAVAILABLE", "remote shell sessions are not enabled in this composition", 409);
    }
    try {
      return await manager.adminClose({ sessionId, reason: "closed from the management page" });
    } catch (error) {
      throw mapManagerError(error);
    }
  }

  return async function handler(req, res) {
    try {
      // Fail closed on the shared Host/Origin + browser-cookie fence. Without a
      // connection service (non-browser composition) the route is not mounted by
      // lib/index.js at all, so a missing fence here is a configuration error.
      const connection = ctx?.get?.("connection");
      if (connection === undefined || connection === null || typeof connection.requestRejection !== "function") {
        return writeJson(res, 503, {
          ok: false,
          error: { code: "FENCE_UNAVAILABLE", message: "browser trust checks are unavailable" },
        });
      }
      const rejection = connection.requestRejection?.(req);
      if (rejection !== undefined && rejection !== false && rejection !== null) {
        return writeJson(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "forbidden" } });
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return writeJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } });
      }
      const url = new URL(req.url ?? "/", "http://dsh.local");
      if (url.pathname.replace(/\/+$/u, "") !== API_PREFIX) {
        return writeJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown management route" } });
      }
      const body = await readJsonBody(req);
      if (body.method === "auth.password") {
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", disconnect);
        try {
          const result = await dispatch(body, controller.signal);
          return writeJson(res, 200, { ok: true, result });
        } finally {
          res.removeListener("close", disconnect);
          delete body.password;
        }
      }
      const result = await dispatch(body);
      return writeJson(res, 200, { ok: true, result });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : "INTERNAL";
      if (!(error instanceof ApiError)) {
        warn(`dsh-remote: management API failed: ${messageOf(error)}`);
      }
      return writeJson(res, status, { ok: false, error: { code, message: messageOf(error) } });
    }
  };
}
