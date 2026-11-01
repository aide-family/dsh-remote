/**
 * Bounded audit trail for remote operations.
 *
 * Every model-facing remote tool call is recorded in process memory (ring of
 * `limit` newest entries) and appended to a JSONL file so the management page
 * can show what the agent did and a later harness restart can still display the
 * recent past. Recording and listing are synchronous; file I/O is queued,
 * best-effort, and never throws into the tool path.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default retained entries (process memory + page page size). */
export const DEFAULT_AUDIT_LIMIT = 500;

/**
 * @param {object} [options]
 * @param {number} [options.limit] Retained entries.
 * @param {string} [options.filePath] JSONL persistence path; omit for memory-only.
 * @param {{ warn?: (message: string) => void }} [options.logger]
 */
export function createAuditLog({ limit = DEFAULT_AUDIT_LIMIT, filePath, logger } = {}) {
  const maxEntries = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_AUDIT_LIMIT;
  /** @type {any[]} newest first */
  const entries = [];
  let nextId = 1;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  let disposed = false;

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // logging must never break the audit path
    }
  };

  function record(input) {
    const entry = {
      id: nextId,
      time: Date.now(),
      tool: String(input.tool ?? ""),
      host: String(input.host ?? "—"),
      action: String(input.action ?? input.tool ?? ""),
      risk: String(input.risk ?? ""),
      outcome: input.outcome === "error" || input.outcome === "denied" ? input.outcome : "ok",
      detail: boundDetail(input.detail),
      durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
    };
    nextId += 1;
    entries.unshift(entry);
    while (entries.length > maxEntries) entries.pop();
    if (filePath !== undefined) {
      // Synchronous append: the audit line must survive a headless process that
      // exits immediately after its turn (the plugin's async teardown is not
      // guaranteed to run before `process.exit`).
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch (error) {
        warn(`dsh-remote: audit append failed: ${messageOf(error)}`);
      }
    }
    return entry;
  }

  /** @param {{ limit?: number }} [options] */
  function list({ limit: pageSize = 200 } = {}) {
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 200;
    return entries.slice(0, Math.min(size, maxEntries));
  }

  function clear() {
    entries.length = 0;
    if (filePath !== undefined) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "", "utf8");
      } catch (error) {
        warn(`dsh-remote: audit reset failed: ${messageOf(error)}`);
      }
    }
    return { cleared: true };
  }

  /** Load the retained tail from disk (best effort). */
  async function load() {
    if (filePath === undefined) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const tail = lines.slice(-maxEntries);
    const parsed = [];
    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        if (entry !== null && typeof entry === "object" && Number.isFinite(entry.time)) parsed.push(entry);
      } catch {
        // skip a torn line
      }
    }
    entries.length = 0;
    for (const entry of parsed.reverse()) entries.push(entry);
    nextId = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1;
    if (lines.length > maxEntries) {
      // Bound the file so it cannot grow without limit across restarts.
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, parsed.map((entry) => JSON.stringify(entry)).reverse().join("\n") + "\n", "utf8");
      } catch (error) {
        warn(`dsh-remote: audit compaction failed: ${messageOf(error)}`);
      }
    }
  }

  /** Wait for pending file I/O (tests/disposal). */
  async function flush() {
    await queue;
  }

  async function dispose() {
    disposed = true;
    await queue;
  }

  return {
    record,
    list,
    clear,
    load,
    flush,
    dispose,
    get size() {
      return entries.length;
    },
    get isDisposed() {
      return disposed;
    },
    filePath,
  };
}

/** @param {unknown} value @returns {string} */
export function boundDetail(value, max = 300) {
  const text = String(value ?? "").replaceAll(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
