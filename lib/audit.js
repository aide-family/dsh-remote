/** Bounded, redacted local audit. Persistence failures never hide from health. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactAuditText } from './audit-result.js';

export const DEFAULT_AUDIT_LIMIT = 500;
export const DETAIL_FULL_MAX = 16_384;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const OUTCOMES = new Set(['ok', 'error', 'failed', 'denied', 'cancelled', 'timed_out', 'unknown', 'verification_failed']);
const STATES = new Set(['passed', 'failed', 'timed_out', 'unknown', 'cancelled']);
const stringFields = ['operationId', 'callId', 'rootCallId', 'sessionId', 'agentId', 'backupId', 'beforeVersion', 'afterVersion'];
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const clone = entry => ({ ...entry, ...(entry.verification ? { verification: { ...entry.verification } } : {}),
  ...(entry.targetEvidence ? { targetEvidence: { ...entry.targetEvidence } } : {}) });

export function boundDetail(value, max = 300) {
  return redactAuditText(String(value ?? '').replaceAll(/\s+/gu, ' ').trim(), max);
}
export function boundDetailFull(value, max = DETAIL_FULL_MAX) {
  return redactAuditText(value, max);
}

function normalizeEntry(input, id, time) {
  const entry = {
    id, time,
    tool: boundDetail(input.tool, 120), host: boundDetail(input.host ?? '—', 256),
    action: boundDetail(input.action ?? input.tool, 160), risk: boundDetail(input.risk, 40),
    outcome: input.outcome === undefined ? 'ok' : OUTCOMES.has(input.outcome) ? input.outcome : 'unknown',
    detail: boundDetail(input.detail), detailFull: boundDetailFull(input.detailFull ?? input.detail),
    durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
  };
  for (const field of stringFields) {
    if (typeof input[field] === 'string') entry[field] = boundDetail(input[field], 256);
    else if (input[field] === null && ['backupId', 'beforeVersion', 'afterVersion'].includes(field)) entry[field] = null;
  }
  if (Number.isSafeInteger(input.exitCode)) entry.exitCode = input.exitCode;
  if (typeof input.summary === 'string') entry.summary = boundDetailFull(input.summary, 1024);
  if (typeof input.writeAttempted === 'boolean') entry.writeAttempted = input.writeAttempted;
  if (typeof input.timedOut === 'boolean') entry.timedOut = input.timedOut;
  if (input.truncated === true) entry.truncated = true;
  const target = input.targetEvidence;
  if (target && ['passed', 'failed', 'mismatch', 'unknown'].includes(target.status)) {
    entry.targetEvidence = { status: target.status, checkCount: Number.isSafeInteger(target.checkCount) ? Math.max(0, Math.min(10, target.checkCount)) : 0,
      actionExecuted: typeof target.actionExecuted === 'boolean' ? target.actionExecuted : null, actionAttempted: target.actionAttempted === true };
    if (['owned-pty-subshell', 'ssh-exec-subshell'].includes(target.context)) entry.targetEvidence.context = target.context;
    if (Number.isFinite(target.checkedAt)) entry.targetEvidence.checkedAt = target.checkedAt;
  }
  if (input.verification && typeof input.verification === 'object') {
    entry.verification = {
      status: STATES.has(input.verification.status) ? input.verification.status : 'unknown',
      exitCode: Number.isSafeInteger(input.verification.exitCode) ? input.verification.exitCode : null,
      timedOut: input.verification.timedOut === true,
    };
  }
  return entry;
}

export function createAuditLog({ limit = DEFAULT_AUDIT_LIMIT, filePath, maxBytes = DEFAULT_MAX_BYTES, retentionDays = DEFAULT_RETENTION_DAYS, logger, now = Date.now } = {}) {
  const maxEntries = positive(limit, DEFAULT_AUDIT_LIMIT);
  const byteLimit = positive(maxBytes, DEFAULT_MAX_BYTES);
  const days = positive(retentionDays, DEFAULT_RETENTION_DAYS);
  const entries = []; // newest first
  const pending = new Map(); // new, not-yet-durable calls only; never resurrect old disk history
  let nextId = 1;
  let disposed = false;
  let lastError = null;
  let failedWrites = 0;
  let lastSuccessAt = null;
  let retainedBytes = 0;

  function failure(action, error) {
    failedWrites += 1;
    // Only stable system codes are safe here; never echo arbitrary file contents.
    lastError = `Audit ${action} failed (${boundDetail(error?.code ?? 'IO_ERROR', 80)}).`;
    try { logger?.warn?.(`dsh-remote: ${lastError}`); } catch { /* logging is best effort */ }
  }
  function prune() {
    const before = entries.length;
    const cutoff = now() - days * 86400000;
    for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].time < cutoff) entries.splice(index, 1);
    if (entries.length > maxEntries) entries.length = maxEntries;
    // Bound the exact JSONL bytes, including UTF-8 and trailing newlines.
    let bytes = 0;
    let keep = 0;
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + size > byteLimit) break;
      bytes += size;
      keep += 1;
    }
    entries.length = keep;
    retainedBytes = bytes;
    return before !== entries.length;
  }
  function readDisk() {
    let fd;
    try {
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw Object.assign(new Error('unsafe audit file'), { code: 'UNSAFE_TARGET' });
      const size = Math.min(stats.size, byteLimit);
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const chunk = readSync(fd, bytes, read, size - read, stats.size - size + read);
        if (!chunk) break;
        read += chunk;
      }
      let text = bytes.subarray(0, read).toString('utf8');
      if (stats.size > size) text = text.slice(text.indexOf('\n') + 1);
      const restored = [];
      for (const line of text.split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry && Number.isFinite(entry.time)) restored.push(fitEntry(normalizeEntry(entry, Number.isSafeInteger(entry.id) ? entry.id : 0, entry.time)));
        } catch { /* skip legacy torn lines */ }
      }
      return restored;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function lockFile(path) {
    // Fail visibly on contention, including crash-left locks. Automatic stale
    // unlink has a check/unlink race that can evict a newly acquired live lock;
    // only an operator who has stopped writers may remove a stale lock.
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
  }
  function persist({ clearDisk = false } = {}) {
    if (filePath === undefined) { pending.clear(); return true; }
    let fd;
    let temp;
    let lock;
    let acquired = false;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      lock = join(dirname(filePath), `.${basename(filePath)}.lock`);
      lockFile(lock); acquired = true;
      const disk = clearDisk ? [] : readDisk();
      const identity = entry => entry.operationId ?? createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      const merged = new Map(disk.map(entry => [identity(entry), entry]));
      let maxId = disk.reduce((maximum, entry) => Math.max(maximum, entry.id), 0);
      // Only pending new calls are merged. Old local copies cannot resurrect
      // records cleared or evicted by another instance.
      for (const entry of pending.values()) if (!merged.has(identity(entry))) {
        entry.id = ++maxId;
        fitEntry(entry);
        merged.set(identity(entry), entry);
      }
      entries.length = 0;
      entries.push(...[...merged.values()].sort((a, b) => b.time - a.time || b.id - a.id));
      nextId = Math.max(nextId, maxId + 1);
      prune();
      // One fixed private temp per audit file bounds crash leftovers. The lock
      // prevents touching another live writer's temp; NOFOLLOW rejects links.
      temp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const attrs = fstatSync(fd);
      if (!attrs.isFile() || attrs.nlink !== 1 || (typeof process.getuid === 'function' && attrs.uid !== process.getuid())) {
        throw Object.assign(new Error('unsafe audit temp'), { code: 'UNSAFE_TARGET' });
      }
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeFileSync(fd, entries.slice().reverse().map(entry => JSON.stringify(entry) + '\n').join(''), 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, filePath); temp = undefined;
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(filePath), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      pending.clear();
      lastError = null;
      lastSuccessAt = now();
      return true;
    } catch (error) { failure('write', error); return false; }
    finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* cleanup */ }
      if (temp) try { unlinkSync(temp); } catch { /* exact private temp above */ }
      if (acquired) try { unlinkSync(lock); } catch { /* exact owned lock above */ }
    }
  }
  function pruneAndPersist() { if (prune()) persist(); }
  function fitEntry(entry) {
    // Keep even a large newest operation under a small configured byte budget.
    // Reduce optional text first; never silently discard the whole newest call.
    const priority = ['detailFull', 'summary', 'detail', 'action', 'host', 'tool', ...stringFields];
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 <= byteLimit) return entry;
    entry.truncated = true;
    for (const key of priority) {
      while (typeof entry[key] === 'string' && entry[key].length && Buffer.byteLength(JSON.stringify(entry)) + 1 > byteLimit) {
        const length = Math.floor(entry[key].length / 2);
        entry[key] = length ? entry[key].slice(0, length - 1) + '…' : '';
      }
      if (Buffer.byteLength(JSON.stringify(entry)) + 1 <= byteLimit) break;
    }
    return entry;
  }
  function record(input = {}) {
    const entry = fitEntry(normalizeEntry({ ...input, operationId: input.operationId ?? randomUUID() }, nextId++, now()));
    entries.unshift(entry);
    pending.set(entry.operationId, entry);
    prune();
    const retained = new Set(entries.map(item => item.operationId));
    for (const key of pending.keys()) if (!retained.has(key)) pending.delete(key);
    persist();
    return clone(entry);
  }
  function list({ limit: pageSize = 200, offset = 0, host, full = false } = {}) {
    pruneAndPersist();
    const size = Math.min(positive(pageSize, 200), maxEntries);
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const matching = typeof host === 'string' && host ? entries.filter(entry => entry.host === host) : entries;
    return matching.slice(start, start + size).map(entry => {
      const result = clone(entry);
      if (!full) delete result.detailFull;
      return result;
    });
  }
  function count({ host } = {}) {
    pruneAndPersist();
    return typeof host === 'string' && host ? entries.filter(entry => entry.host === host).length : entries.length;
  }
  function clear() {
    entries.length = 0; pending.clear(); retainedBytes = 0;
    return { cleared: persist({ clearDisk: true }) };
  }
  async function load() {
    if (filePath === undefined) return;
    try {
      const restored = readDisk();
      entries.length = 0;
      entries.push(...restored.reverse());
      nextId = entries.reduce((maximum, entry) => Math.max(maximum, entry.id), 0) + 1;
      prune();
      // Redact legacy history and apply retention immediately under the lock.
      persist();
    } catch (error) { failure('read', error); }
  }
  function health() {
    pruneAndPersist();
    if (lastError && pending.size) persist();
    return { status: filePath === undefined ? 'memory-only' : lastError ? 'degraded' : 'ok', persistent: filePath !== undefined,
      lastError, failedWrites, lastSuccessAt, retainedEntries: entries.length, retainedBytes,
      limits: { entries: maxEntries, bytes: byteLimit, days } };
  }
  async function flush() { if (pending.size) persist(); }
  async function dispose() { await flush(); disposed = true; }
  return { record, list, count, clear, load, health, flush, dispose,
    get size() { pruneAndPersist(); return entries.length; }, get isDisposed() { return disposed; }, filePath };
}
