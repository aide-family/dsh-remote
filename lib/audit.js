/**
 * Bounded audit trail for remote operations.
 *
 * Every model-facing remote tool call is recorded in process memory (ring of
 * `limit` newest entries) and appended to a JSONL file so the management page
 * can show what the agent did and a later harness restart can still display the
 * recent past. `list({ host, offset })` filters by exact host for the per-host
 * audit dialog and `count({ host })` totals the matching entries. Recording and
 * listing are synchronous; file I/O is queued, best-effort, and never throws
 * into the tool path.
 *
 * Every entry keeps two detail fields (v0.5.1): `detail` (300-char one-line,
 * for the table) and `detailFull` (the raw command/script/path, whitespace
 * preserved, bounded to 16 384 chars) for the expand-row viewer and exports.
 * `list()` omits `detailFull` unless called with `full: true`, and legacy JSONL
 * entries written before v0.5.1 are backfilled from `detail`.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default retained entries (process memory + page page size). */
export const DEFAULT_AUDIT_LIMIT = 500;
/** Upper bound for the raw, whitespace-preserving `detailFull` field. */
export const DETAIL_FULL_MAX = 16_384;

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
      detailFull: boundDetailFull(input.detail),
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

  /**
   * List audit entries, newest first.
   *
   * Backwards compatible: with no arguments it returns the newest `limit`
   * entries as an array. `host` filters by exact `entry.host` equality (no
   * globs) and `offset` pages through the matching entries.
   *
   * `full: true` includes the raw `detailFull` field; the default page stays
   * lightweight (detailFull omitted) for the overview and the audit table.
   *
   * @param {{ limit?: number, offset?: number, host?: string, full?: boolean }} [options]
   * @returns {any[]}
   */
  function list({ limit: pageSize = 200, offset = 0, host, full } = {}) {
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 200;
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const hostFilter = typeof host === "string" && host.length > 0 ? host : undefined;
    const matching =
      hostFilter === undefined ? entries : entries.filter((entry) => entry.host === hostFilter);
    const page = matching.slice(start, start + Math.min(size, maxEntries));
    if (full === true) return page;
    return page.map((entry) => {
      const { detailFull, ...rest } = entry;
      return rest;
    });
  }

  /**
   * Count audit entries, optionally for one exact host.
   *
   * @param {{ host?: string }} [options]
   * @returns {number}
   */
  function count({ host } = {}) {
    const hostFilter = typeof host === "string" && host.length > 0 ? host : undefined;
    if (hostFilter === undefined) return entries.length;
    let total = 0;
    for (const entry of entries) {
      if (entry.host === hostFilter) total += 1;
    }
    return total;
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
        if (entry !== null && typeof entry === "object" && Number.isFinite(entry.time)) {
          // Legacy (pre-v0.5.1) lines have no detailFull; backfill from detail
          // so the full viewer/export sees a string for every entry.
          if (typeof entry.detailFull !== "string") entry.detailFull = boundDetailFull(entry.detail);
          parsed.push(entry);
        }
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
    count,
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

/**
 * Raw, whitespace-preserving detail for the full viewer and exports.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function boundDetailFull(value, max = DETAIL_FULL_MAX) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
