/**
 * Deterministic model-facing rendering for dsh-remote tool results.
 *
 * `lib/tools.js` builds canonical JSON values (see docs/ARCHITECTURE.md
 * "Canonical values") and the renderers here turn them into plain text content
 * blocks. Rendering is pure: same value in, same text out. Numbers and times
 * that appear in the output are facts reported by the remote side; nothing is
 * stamped locally.
 *
 * Every renderer returns `[{ type: "text", text }]`.
 */

/** Probe info keys in the order they are printed. */
const PROBE_KEYS = ["hostname", "user", "os", "kernel", "uptime", "load", "memory", "diskRoot"];
const PROBE_INFO_KEYS = new Set(PROBE_KEYS);

/**
 * Build the renderer table injected as `output.render` in every tool.
 *
 * @param {object} [config] Normalized plugin config (only display thresholds are read).
 * @returns {Record<string, (args: unknown, value: any) => Array<{ type: "text", text: string }>>}
 */
export function createRenderers(config = {}) {
  const maxOutputBytes = finiteNumber(config?.maxOutputBytes, 200_000);
  return {
    remote_hosts: (_args, value) => blocks(formatHosts(value, config ?? {})),
    remote_probe: (_args, value) => blocks(formatProbe(value)),
    remote_exec: (_args, value) => blocks(formatExec(value, maxOutputBytes) + (value?.targetEvidence ? `\nTarget checks: ${value.targetEvidence.status} (${value.targetEvidence.context}); command exit proof is separate.` : "")),
    remote_read: (_args, value) => blocks(formatRead(value) + sftpTargetWarning(value)),
    remote_list: (_args, value) => blocks(formatList(value) + sftpTargetWarning(value)),
    remote_write: (_args, value) => blocks(formatWrite(value)),
    remote_edit: (_args, value) => blocks(formatEdit(value)),
    remote_transfer: (_args, value) => blocks(formatTransfer(value)),
    remote_restore: (_args, value) => blocks(formatRestore(value)),
  };
}

/**
 * @param {string} text
 * @returns {Array<{ type: "text", text: string }>}
 */
function blocks(text) {
  return [{ type: "text", text }];
}
function sftpTargetWarning(value) {
  return value?.targetVerification === "not-applied-sftp" ? "\nSFTP view is not target-verified; do not use this output as verified execution-target evidence." : "";
}

/**
 * Host table plus policy hints.
 *
 * @param {object} value Canonical `remote_hosts` value.
 * @param {object} [config]
 * @returns {string}
 */
export function formatHosts(value, config = {}) {
  const hosts = Array.isArray(value?.hosts) ? value.hosts : [];
  const total = finiteNumber(value?.total, hosts.length);
  const blocked = finiteNumber(value?.blocked, 0);
  const lines = [];

  if (hosts.length === 0) {
    lines.push("No remote hosts are available.");
    lines.push("Add hosts to the plugin configuration or ~/.ssh/config, then call remote_hosts again.");
  } else {
    lines.push(`${total} remote host${total === 1 ? "" : "s"}:`);
    const rows = hosts.map((host) => [
      text(host?.name, "?"),
      formatTarget(host),
      text(host?.source, "?"),
      hostNotes(host),
    ]);
    const headers = ["NAME", "TARGET", "SOURCE", "NOTES"];
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => row[index].length)),
    );
    const renderRow = (row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
        .join("  ")
        .trimEnd();
    lines.push(renderRow(headers));
    for (const row of rows) lines.push(renderRow(row));
  }

  lines.push(policyHint(config?.policy));
  const readonlyHosts = hosts.filter((host) => host?.readonly === true).map((host) => text(host?.name, "?"));
  if (readonlyHosts.length > 0) {
    lines.push(`Read-only hosts (mutating actions denied): ${readonlyHosts.join(", ")}.`);
  }
  if (blocked > 0) {
    lines.push(
      `${blocked} host${blocked === 1 ? "" : "s"} hidden by allowHosts; call remote_hosts with all=true to list them.`,
    );
  }
  return lines.join("\n");
}

/**
 * `user@host:port`, using 22 when the port is not stored.
 *
 * @param {any} host
 * @returns {string}
 */
function formatTarget(host) {
  const user = host?.username === null || host?.username === undefined ? "" : `${host.username}@`;
  const port = host?.port === null || host?.port === undefined ? 22 : host.port;
  return `${user}${text(host?.host, text(host?.name, "?"))}:${port}`;
}

/**
 * Short notes column: flags, tags, description.
 *
 * @param {any} host
 * @returns {string}
 */
function hostNotes(host) {
  const notes = [];
  if (host?.readonly === true) notes.push("read-only");
  if (host?.allowed === false) notes.push("blocked by allowHosts");
  if (Array.isArray(host?.tags) && host.tags.length > 0) notes.push(`tags: ${host.tags.join(", ")}`);
  if (typeof host?.description === "string" && host.description.trim().length > 0) {
    notes.push(host.description.trim());
  }
  return notes.length === 0 ? "-" : notes.join("; ");
}

/**
 * Probe facts.
 *
 * @param {object} value Canonical `remote_probe` value.
 * @returns {string}
 */
export function formatProbe(value) {
  const latency = finiteNumber(value?.latencyMs, undefined);
  const status = value?.ok === true ? "ok" : "unreachable";
  const lines = [`${text(value?.host, "?")}: ${status}${latency === undefined ? "" : ` (${latency}ms)`}`];
  if (typeof value?.banner === "string" && value.banner.trim().length > 0) {
    lines.push(`banner: ${value.banner.trim()}`);
  }
  const info = value?.info !== null && typeof value?.info === "object" ? value.info : {};
  for (const key of PROBE_KEYS) {
    const fact = info[key];
    if (typeof fact === "string" && fact.trim().length > 0) lines.push(`${key}: ${fact.trim()}`);
  }
  const warnings = Array.isArray(value?.warnings) ? value.warnings : [];
  for (const warning of warnings) lines.push(`warning: ${text(warning, "")}`.trimEnd());
  return lines.join("\n");
}

/**
 * Exec result: exit code, stdout, stderr section, then markers.
 *
 * @param {object} value Canonical `remote_exec` value.
 * @param {number} [maxOutputBytes]
 * @returns {string}
 */
export function formatExec(value, maxOutputBytes = 200_000) {
  const exitCode = finiteNumber(value?.exitCode, -1);
  const stdout = stripTrailingNewlines(text(value?.stdout, ""));
  const stderr = stripTrailingNewlines(text(value?.stderr, ""));
  const lines = [`[exit code: ${exitCode}]`];
  if (stdout.length > 0) lines.push(stdout);
  if (stderr.trim().length > 0) lines.push("[stderr]", stderr);
  if (value?.truncated === true) {
    const cap = finiteNumber(maxOutputBytes, 200_000);
    lines.push(`[output truncated; each stream was capped at ${cap} bytes (tail kept)]`);
  }
  if (value?.timedOut === true) {
    const duration = finiteNumber(value?.durationMs, undefined);
    lines.push(`[timeout after ${duration === undefined ? "the configured timeout" : `${duration}ms`}]`);
  }
  if (stdout.length === 0 && stderr.trim().length === 0) lines.push("[no output]");
  return lines.join("\n");
}

/**
 * Numbered read window plus the continue offset.
 *
 * @param {object} value Canonical `remote_read` value.
 * @returns {string}
 */
export function formatRead(value) {
  const host = text(value?.host, "?");
  const path = text(value?.path, "?");
  const offset = finiteNumber(value?.offset, 1);
  const lineCount = finiteNumber(value?.lineCount, 0);
  const size = finiteNumber(value?.size, 0);
  const body = typeof value?.content === "string" && value.content.length > 0 ? value.content.split("\n") : [];
  const lines = [];

  if (lineCount === 0) {
    lines.push(`${host}:${path} (empty; ${size} bytes)`);
    lines.push("[no lines]");
  } else {
    const end = body.length === 0 ? offset : offset + body.length - 1;
    lines.push(`${host}:${path} (lines ${offset}-${end} of ${lineCount}; ${size} bytes)`);
    if (body.length === 0) {
      lines.push("[no lines in this range]");
    } else {
      for (let index = 0; index < body.length; index += 1) {
        lines.push(`${offset + index}: ${body[index]}`);
      }
    }
  }
  const nextOffset = finiteNumber(value?.nextOffset, undefined);
  if (nextOffset !== undefined) lines.push(`[truncated; continue with offset ${nextOffset}]`);
  return lines.join("\n");
}

/**
 * One line per directory entry.
 *
 * @param {object} value Canonical `remote_list` value.
 * @returns {string}
 */
export function formatList(value) {
  const host = text(value?.host, "?");
  const path = text(value?.path, "?");
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  const total = finiteNumber(value?.total, entries.length);
  const lines = [`${host}:${path} (${total} entr${total === 1 ? "y" : "ies"})`];
  for (const entry of entries) {
    const mtime = finiteNumber(entry?.mtimeMs, undefined);
    const size = finiteNumber(entry?.size, 0);
    lines.push(
      `${text(entry?.type, "other")}  ${size}  ${mtime === undefined ? "-" : new Date(mtime).toISOString()}  ${text(entry?.name, "?")}`,
    );
  }
  if (entries.length < total) {
    lines.push(`[truncated; showing first ${entries.length} of ${total} entries]`);
  }
  return lines.join("\n");
}

/**
 * @param {object} value Canonical `remote_write` value.
 * @returns {string}
 */
export function formatWrite(value) {
  const mode = finiteNumber(value?.mode, undefined);
  const suffix = mode === undefined ? "" : `, mode 0o${mode.toString(8).padStart(3, "0")}`;
  const action = value?.created === true ? "created" : "replaced";
  return `Wrote ${finiteNumber(value?.bytesWritten, 0)} bytes to ${text(value?.host, "?")}:${text(value?.path, "?")} (${action}${suffix}).` + formatChangeFacts(value);
}

/**
 * @param {object} value Canonical `remote_edit` value.
 * @returns {string}
 */
export function formatEdit(value) {
  const replacements = finiteNumber(value?.replacements, 0);
  return `Edited ${text(value?.host, "?")}:${text(value?.path, "?")}: ${replacements} replacement${replacements === 1 ? "" : "s"}, ${finiteNumber(value?.bytesWritten, 0)} bytes written.` + formatChangeFacts(value);
}

/** Recovery facts must reach the Agent, not just the structured JSON audit. */
export function formatChangeFacts(value) {
  const lines = [];
  if (value?.backupId) lines.push(`Backup ID: ${value.backupId} (remote_restore requires approval).`);
  if (value?.beforeVersion) lines.push(`Before version: ${value.beforeVersion}`);
  if (value?.afterVersion) lines.push(`After version: ${value.afterVersion}`);
  if (value?.verification) {
    const verification = value.verification;
    lines.push(`Verification: ${text(verification.status, "unknown")}; exit code: ${text(verification.exitCode, "unknown")}${verification.timedOut ? "; timed out" : ""}.`);
    if (verification.status !== "passed") lines.push("Do not reload or retry automatically; inspect the current state first.");
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

export function formatRestore(value) {
  return `Restored ${text(value?.host, "?")}:${text(value?.path, "?")}: ${finiteNumber(value?.bytesWritten, 0)} bytes written.` + formatChangeFacts(value);
}

/**
 * @param {object} value Canonical `remote_transfer` value.
 * @returns {string}
 */
export function formatTransfer(value) {
  const host = text(value?.host, "?");
  const direction = value?.direction === "download" ? "download" : "upload";
  const localPath = text(value?.localPath, "?");
  const remotePath = text(value?.remotePath, "?");
  const bytes = finiteNumber(value?.bytes, 0);
  const duration = finiteNumber(value?.durationMs, 0);
  if (direction === "download") {
    return `Downloaded ${bytes} bytes from ${host}:${remotePath} to ${localPath} in ${duration}ms.`;
  }
  return `Uploaded ${bytes} bytes from ${localPath} to ${host}:${remotePath} in ${duration}ms.`;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function text(value, fallback) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripTrailingNewlines(value) {
  return value.replace(/\n+$/u, "");
}

// ---------------------------------------------------------------------------
// Shared small helpers
//
// These are pure and dependency-free; they live here (rather than in
// lib/tools.js) so the tool-definition file stays within its size budget. The
// renderers above use them too.
// ---------------------------------------------------------------------------

/** @param {string} [policy] @returns {string} */
export function policyHint(policy) {
  switch (policy) {
    case "always":
      return "Approval policy: always — every action requires approval (and fails closed without an answerer).";
    case "never":
      return "Approval policy: never — read-only actions run; mutating actions are denied.";
    default:
      return "Approval policy: auto — read-only actions run; mutating actions require approval (and fail closed without an answerer).";
  }
}

/** Coarse auth label for the host table; never exposes any secret value. */
export function authHintFor(host) {
  if (typeof host?.passwordEnv === "string" && host.passwordEnv.length > 0) return "password (from env)";
  if (typeof host?.identityFile === "string" && host.identityFile.length > 0) return "publickey (identity file)";
  return "ssh-agent or default key";
}

/** Run the static classifier, degrading to "gray" when the gate is incomplete. */
export function assessCommand(approval, command) {
  if (typeof approval?.assessCommand !== "function") return { level: "gray", verb: "unknown" };
  const assessment = approval.assessCommand(command);
  if (assessment === null || typeof assessment !== "object") return { level: "gray", verb: "unknown" };
  return {
    level: assessment.level === "low" || assessment.level === "high" ? assessment.level : "gray",
    verb: typeof assessment.verb === "string" ? assessment.verb : "unknown",
    ...(typeof assessment.denied === "string" ? { denied: assessment.denied } : {}),
  };
}

/** Parse `@@key@@value` probe lines into facts; unknown/empty values are dropped. */
export function parseProbeInfo(stdout) {
  const info = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const match = /^@@([A-Za-z][A-Za-z0-9]*)@@(.*)$/u.exec(line);
    if (match === null || !PROBE_INFO_KEYS.has(match[1])) continue;
    const value = match[2].trim();
    if (value.length > 0) info[match[1]] = value;
  }
  return info;
}

/** Normalize an entry type into the transport vocabulary. */
export function normalizeEntryType(type) {
  return type === "file" || type === "dir" || type === "symlink" ? type : "other";
}

/** Split text into lines, dropping one trailing newline and CRLF carriage returns. */
export function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/** Wrap one failure with action context and the underlying error.code. */
export function wrapError(label, error) {
  if (error !== null && error !== undefined && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === "string" && error.code.length > 0 ? ` (code: ${error.code})` : "";
  const wrapped = new Error(`${label}: ${message}${code}`);
  if (error?.code !== undefined) wrapped.code = error.code;
  for (const key of ["targetEvidence", "change", "outcome"]) if (error?.[key] !== undefined) wrapped[key] = error[key];
  return wrapped;
}

/** Run one transport operation, wrapping its failure. */
export async function remoteCall(label, operation) {
  try {
    return await operation();
  } catch (error) {
    throw wrapError(label, error);
  }
}

/** One-line error description including the code when present. */
export function describeError(error) {
  if (error === null || error === undefined) return "";
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error?.code === "string" && error.code.length > 0) return `${message} (code: ${error.code})`;
  return message;
}

/** Collapse whitespace into one line. */
export function oneLine(text) {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/** Throw a proper AbortError when the caller's signal is already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted !== true) return;
  const error = new Error("The remote operation was aborted.");
  error.name = "AbortError";
  throw error;
}

/** Positive finite number or the fallback. */
export function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Finite number or the fallback. */
export function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Validate and floor a positive integer argument, optionally clamped. */
export function normalizePositiveInt(value, fallback, label, maximum) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const integer = Math.floor(value);
  return maximum === undefined ? integer : Math.min(integer, maximum);
}

/** Validate and floor a positive timeout argument. */
export function normalizeTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("timeout_ms must be a positive number of milliseconds.");
  }
  return Math.floor(value);
}

/** Short single-line text for a UI title. */
export function shortText(value, fallback) {
  const text = typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim() : "";
  if (text.length === 0) return fallback;
  return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS - 3)}...`;
}

/** UI title length budget. */
export const MAX_TITLE_CHARS = 72;
