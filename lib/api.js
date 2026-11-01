/**
 * Host HTTP API behind the browser "Remote Ops" management page.
 *
 * Registered by `lib/index.js` on the DSH web server under
 * `/dsh-remote/api` (prefix route). Every request must pass the Host connection
 * fence (the same Host/Origin + browser-cookie check `/api` uses) and is
 * answered from the plugin's own services:
 *
 *   POST { method: "overview" }                        -> hosts / sessions / audit
 *   POST { method: "host.test", name }                 -> read-only connectivity probe
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
 * @param {{ warn?: (m: string) => void }} [deps.logger]
 * @param {() => string} [deps.workspaceRoot] Session-independent project dir hint.
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createManagementApi({ ctx, config, hosts, transport, manager, audit, hub, logger }) {
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
    const hostViews = listed.map((host) => ({
      name: host.name,
      host: host.host,
      target: formatTarget(host),
      port: host.port ?? 22,
      username: host.username ?? null,
      source: host.source,
      description: host.description ?? null,
      tags: host.tags ?? [],
      readonly: hosts.isReadonly(host),
      allowed: hosts.isAllowed(host),
      authHint: authHintFor(host),
    }));
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
