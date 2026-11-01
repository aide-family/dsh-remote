/**
 * Internal helpers for the dsh-remote management API (`lib/api.js`).
 *
 * Split out of `lib/api.js` (v0.5.1) to keep both files under the ~700-line
 * convention: `ApiError` + the documented status table, input validators, the
 * defensive JSON body/reply helpers, and the bounded `terminal.trace`
 * diagnostics append. No route registration lives here.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Maximum accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Maximum size of the client trace log before it is trimmed. */
export const TRACE_LOG_MAX_BYTES = 256 * 1024;
/** Bytes kept after a trace-log trim (last chunk). */
export const TRACE_LOG_KEEP_BYTES = 64 * 1024;

/**
 * Error codes and HTTP statuses documented for the v0.5 host/terminal methods.
 * Registry/relay errors are mapped onto these so the browser sees a stable
 * contract instead of internal module error objects.
 *
 * @type {Record<string, number>}
 */
export const ERROR_STATUS = Object.freeze({
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

export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** @param {string} value */
export function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function optionalPositiveInt(value, field) {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-negative integer`);
  }
  return numeric;
}

/** @param {unknown} error */
export function mapManagerError(error) {
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
export function fail(code, message) {
  return new ApiError(code, message, ERROR_STATUS[code] ?? 400);
}

/** @param {any} host */
export function isManaged(host) {
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
export function safeFlag(read, fallback) {
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
export function remoteHostOf(record) {
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
export function requireHostInput(body, method) {
  const input = body?.host;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw fail("HOST_INVALID", `${method} requires a "host" input object`);
  }
  return input;
}

/** @param {unknown} value */
export function requireHostName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("HOST_INVALID", "name must be a non-empty string");
  }
  return value.trim();
}

/** @param {unknown} value */
export function optionalAuditHost(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("AUDIT_INVALID", "host must be a non-empty string");
  }
  return value.trim();
}

/**
 * `audit.list({ full })`: true requests the raw `detailFull` field. Anything
 * other than a boolean is rejected with AUDIT_INVALID.
 *
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
export function optionalAuditFull(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw fail("AUDIT_INVALID", "full must be a boolean");
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number | undefined}
 */
export function optionalAuditInteger(value, field, min, max) {
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
export function requireTerminalArg(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function optionalTerminalSessionId(value) {
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
export function mapTerminalError(error) {
  const code = typeof (/** @type {any} */ (error)?.code) === "string" ? /** @type {any} */ (error).code : "";
  if (code === "HOST_DISALLOWED") return fail("HOST_DISALLOWED", messageOf(error));
  if (code === "HOST_NOT_FOUND" || code === "UNKNOWN_HOST") return fail("HOST_NOT_FOUND", messageOf(error));
  if (code === "TERMINAL_DISABLED") return fail("TERMINAL_DISABLED", messageOf(error));
  if (code === "TERMINAL_NOT_FOUND") return fail("TERMINAL_NOT_FOUND", messageOf(error));
  return fail("TERMINAL_ERROR", messageOf(error));
}

/** @param {object} host */
export function formatTarget(host) {
  const user = host.username?.trim();
  const target = `${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  return user ? `${user}@${target}` : target;
}

/** @param {object} host */
export function authHintFor(host) {
  if (typeof host.passwordEnv === "string" && host.passwordEnv.length > 0) return "password env";
  if (typeof host.identityFile === "string" && host.identityFile.length > 0) return "key file";
  if (typeof process.env.SSH_AUTH_SOCK === "string" && process.env.SSH_AUTH_SOCK.length > 0) return "ssh-agent";
  return "default keys";
}

/**
 * Read a bounded JSON body.
 * @param {import("node:http").IncomingMessage} req
 */
export async function readJsonBody(req) {
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
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/** @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append one newline-delimited trace line, bounded to 256 KiB and trimmed to
 * the last 64 KiB once it overflows (same policy as the bridge log). Every
 * filesystem error is swallowed: client tracing must never affect an action.
 *
 * @param {string} filePath absolute trace log path
 * @param {string} line one JSON line (without the trailing newline)
 * @returns {boolean} true when the line was written
 */
export function appendBoundedTraceLine(filePath, line) {
  if (typeof filePath !== "string" || filePath.trim() === "") return false;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${line}\n`, "utf8");
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= TRACE_LOG_MAX_BYTES) return true;
    const raw = readFileSync(filePath);
    let start = Math.max(0, raw.length - TRACE_LOG_KEEP_BYTES);
    const newline = raw.indexOf(10, start);
    writeFileSync(filePath, raw.subarray(newline === -1 ? start : newline + 1));
    return true;
  } catch {
    return false;
  }
}
