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
 *   POST { method: "audit.list", host?, limit?, offset? } -> host-filtered audit page
 *   POST { method: "terminal.open", name, sessionId? } -> open/reuse a user SSH PTY
 *   POST { method: "terminal.list", sessionId? }       -> user terminal sessions
 *   POST { method: "terminal.close", sessionKey }      -> close a user terminal session
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
/** Maximum accepted request body. */
const MAX_BODY_BYTES = 64 * 1024;
/** Bound for a management connection test. */
const HOST_TEST_TIMEOUT_MS = 12_000;
const HOST_TEST_MAX_BYTES = 8_192;
/** Page cap for `audit.list` (the audit ring is bounded anyway). */
const AUDIT_MAX_LIMIT = 1_000;

/**
 * Error codes and HTTP statuses documented for the v0.5 host/terminal methods.
 * Registry/relay errors are mapped onto these so the browser sees a stable
 * contract instead of internal module error objects.
 *
 * @type {Record<string, number>}
 */
const ERROR_STATUS = Object.freeze({
  HOST_INVALID: 400,
  HOST_EXISTS: 409,
  HOST_NOT_FOUND: 404,
  HOST_NOT_MANAGED: 400,
  HOST_DISALLOWED: 403,
  TERMINAL_DISABLED: 400,
  TERMINAL_NOT_FOUND: 404,
  TERMINAL_ERROR: 500,
  AUDIT_INVALID: 400,
});

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

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
  logger,
}) {
  // The host store is the object that owns the discovery cache. Older
  // compositions/tests pass only `hosts`; both are accepted.
  const store = hostStore ?? hosts;
  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // ignore
    }
  };

  async function dispatch(body) {
    const method = typeof body?.method === "string" ? body.method : "";
    switch (method) {
      case "overview":
        return overview();
      case "host.test":
        return hostTest(requireString(body.name, "name"));
      case "host.create":
        return hostCreate(body);
      case "host.update":
        return hostUpdate(body);
      case "host.delete":
        return hostDelete(body);
      case "audit.list":
        return auditList(body);
      case "terminal.open":
        return terminalOpen(body);
      case "terminal.list":
        return terminalList(body);
      case "terminal.close":
        return terminalClose(body);
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
      audit: audit.list({ limit: 200 }),
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
    const filter = host === undefined ? {} : { host };
    let entries;
    let total;
    try {
      entries = audit.list({
        ...filter,
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
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

  async function terminalOpen(body) {
    const terminal = requireTerminal();
    const name = requireTerminalArg(body?.name, "name");
    const sessionId = optionalTerminalSessionId(body?.sessionId);
    await ensureRelayStarted(terminal);
    let opened;
    try {
      opened = await terminal.open({
        hostName: name,
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
      if (connection === undefined || connection === null) {
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

/** @param {string} value */
function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function optionalPositiveInt(value, field) {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-negative integer`);
  }
  return numeric;
}

/** @param {unknown} error */
function mapManagerError(error) {
  const code = error?.code;
  if (code === "NO_SESSION") return new ApiError("NO_SESSION", messageOf(error), 404);
  return new ApiError("SESSION_ERROR", messageOf(error), 400);
}

// --- v0.5 host/terminal helpers -------------------------------------------

/**
 * Build an ApiError from the documented code table (every code has a status).
 *
 * @param {string} code
 * @param {string} message
 * @returns {ApiError}
 */
function fail(code, message) {
  return new ApiError(code, message, ERROR_STATUS[code] ?? 400);
}

/** @param {any} host */
function isManaged(host) {
  return host?.managed === true || host?.source === "managed";
}

/**
 * Read a policy flag from the host store without letting a store error blank the
 * whole overview page.
 *
 * @param {() => boolean} read
 * @param {boolean} fallback
 * @returns {boolean}
 */
function safeFlag(read, fallback) {
  try {
    const value = read();
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A RemoteHost-shaped view of a raw ManagedHost record, for the fallback path
 * where merged discovery failed right after a mutation.
 *
 * @param {any} record
 * @returns {object}
 */
function remoteHostOf(record) {
  const name = String(record?.name ?? "");
  return {
    id: `managed:${name}`,
    name,
    host: String(record?.host ?? ""),
    port: record?.port ?? 22,
    username: record?.username,
    source: "managed",
    managed: true,
    identityFile: record?.identityFile,
    passwordEnv: record?.passwordEnv,
    passphraseEnv: record?.passphraseEnv,
    proxyJump: record?.proxyJump,
    tags: record?.tags,
    description: record?.description,
  };
}

/**
 * @param {any} body
 * @param {string} method
 * @returns {Record<string, unknown>}
 */
function requireHostInput(body, method) {
  const input = body?.host;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw fail("HOST_INVALID", `${method} requires a "host" input object`);
  }
  return input;
}

/** @param {unknown} value */
function requireHostName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("HOST_INVALID", "name must be a non-empty string");
  }
  return value.trim();
}

/** @param {unknown} value */
function optionalAuditHost(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("AUDIT_INVALID", "host must be a non-empty string");
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number | undefined}
 */
function optionalAuditInteger(value, field, min, max) {
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
    throw fail("AUDIT_INVALID", `${field} must be an integer between ${min} and ${max}`);
  }
  return numeric;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireTerminalArg(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalTerminalSessionId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return requireTerminalArg(value, "sessionId");
}

/**
 * Map relay/host errors onto the documented terminal error codes. Anything
 * unexpected becomes a TERMINAL_ERROR so the browser still gets a structured
 * answer.
 *
 * @param {unknown} error
 * @returns {ApiError}
 */
function mapTerminalError(error) {
  const code = typeof (/** @type {any} */ (error)?.code) === "string" ? /** @type {any} */ (error).code : "";
  if (code === "HOST_DISALLOWED") return fail("HOST_DISALLOWED", messageOf(error));
  if (code === "HOST_NOT_FOUND" || code === "UNKNOWN_HOST") return fail("HOST_NOT_FOUND", messageOf(error));
  if (code === "TERMINAL_DISABLED") return fail("TERMINAL_DISABLED", messageOf(error));
  if (code === "TERMINAL_NOT_FOUND") return fail("TERMINAL_NOT_FOUND", messageOf(error));
  return fail("TERMINAL_ERROR", messageOf(error));
}

/** @param {object} host */
function formatTarget(host) {
  const user = host.username?.trim();
  const target = `${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  return user ? `${user}@${target}` : target;
}

/** @param {object} host */
function authHintFor(host) {
  if (typeof host.passwordEnv === "string" && host.passwordEnv.length > 0) return "password env";
  if (typeof host.identityFile === "string" && host.identityFile.length > 0) return "key file";
  if (typeof process.env.SSH_AUTH_SOCK === "string" && process.env.SSH_AUTH_SOCK.length > 0) return "ssh-agent";
  return "default keys";
}

/**
 * Read a bounded JSON body.
 * @param {import("node:http").IncomingMessage} req
 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ApiError("BODY_TOO_LARGE", "request body is too large", 413);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("INVALID_ARGUMENT", "request body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_JSON", "request body must be valid JSON");
  }
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {object} payload */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
