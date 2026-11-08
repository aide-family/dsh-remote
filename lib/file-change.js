import { createHash } from "node:crypto";
import { posix } from "node:path";
import { createBackupStore, serializeTarget } from "./file-change-store.js";

function fail(message, code) { return Object.assign(new Error(message), { code }); }
function validMetadata(record) {
  return Number.isInteger(record.mode) && record.mode >= 0 && record.mode <= 0xffff &&
    Number.isInteger(record.uid) && record.uid >= 0 && record.uid <= 0xfffffffe &&
    Number.isInteger(record.gid) && record.gid >= 0 && record.gid <= 0xfffffffe;
}
export function hostBinding(host) {
  return JSON.stringify([host.id ?? null, host.name, host.host, host.port ?? 22, host.username ?? null, host.proxyJump ?? []]);
}
export function fileVersion(snapshot) {
  if (!snapshot) return "absent";
  return createHash("sha256").update(JSON.stringify([snapshot.mode ?? null, snapshot.uid ?? null, snapshot.gid ?? null])).update(snapshot.content).digest("hex");
}

/** Bounded whole-file +/- preview. Never store previews in audit/backup metadata. */
export function changePreview(path, before, after) {
  const header = `--- ${path} (before)\n+++ ${path} (after)\n`;
  const lines = content => content.length ? content.toString("utf8").split("\n") : [];
  const oldLines = lines(before), newLines = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
  if (prefix === oldLines.length && prefix === newLines.length) return header + "[No content changes; metadata may change]\n";
  const start = Math.max(0, prefix - 3), context = Math.min(3, suffix);
  const oldEnd = oldLines.length - suffix, newEnd = newLines.length - suffix;
  let text = header + `@@ -${start + 1},${oldEnd - start + context} +${start + 1},${newEnd - start + context} @@\n`;
  let bytes = Buffer.byteLength(text);
  const chunks = [[" ", oldLines.slice(start, prefix)], ["-", oldLines.slice(prefix, oldEnd)],
    ["+", newLines.slice(prefix, newEnd)], [" ", oldLines.slice(oldEnd, oldEnd + context)]];
  let truncated = false;
  for (const [marker, chunk] of chunks) {
    // Reserve separate before/after budgets so a huge removal cannot hide every addition.
    let sectionBytes = 0;
    const sectionLimit = marker === " " ? 2048 : 20 * 1024;
    for (const line of chunk) {
      const next = `${marker}${line}\n`;
      const size = Buffer.byteLength(next);
      if (sectionBytes + size > sectionLimit || bytes + size > 46 * 1024) {
        const note = `[${marker === "-" ? "Removed" : marker === "+" ? "Added" : "Context"} lines truncated]\n`;
        text += note;
        bytes += Buffer.byteLength(note);
        truncated = true;
        break;
      }
      text += next;
      bytes += size;
      sectionBytes += size;
    }
  }
  return text + (truncated ? "[Diff truncated at 48 KiB; full file change not shown]\n" : "");
}

/** Safe changes serialize plugin writers; SFTP cannot atomically CAS external writers. */
export function createFileChanges({ transport, backupRoot, maxReadBytes, authorize, verify, beforeWrite }) {
  const store = createBackupStore(backupRoot, maxReadBytes);
  async function snapshot(host, path, signal) {
    signal?.throwIfAborted();
    let info;
    try { info = await transport.stat(host, path, { signal }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (info.type !== "file") throw fail(`Cannot change ${path}: target is ${info.type}; only regular files are supported (no symlinks).`, "UNSAFE_FILE_TYPE");
    if (!validMetadata(info)) throw fail(`Cannot change ${path}: complete mode/uid/gid metadata is unavailable.`, "METADATA_UNAVAILABLE");
    if (info.size > maxReadBytes) throw fail(`Cannot edit ${path}: file exceeds the configured read limit.`, "FILE_TOO_LARGE");
    const data = await transport.readFile(host, path, { maxBytes: maxReadBytes, signal });
    if (data.truncated || data.content.length > maxReadBytes) throw fail(`Cannot edit ${path}: file exceeds the configured read limit.`, "FILE_TOO_LARGE");
    const content = Buffer.from(data.content);
    if (!Buffer.from(content.toString("utf8"), "utf8").equals(content)) {
      throw fail(`Cannot change ${path}: safe text changes require valid UTF-8; refusing a lossy binary Diff.`, "INVALID_UTF8");
    }
    return { content, mode: info.mode, uid: info.uid, gid: info.gid };
  }
  function targetPath(path) {
    if (!posix.isAbsolute(path) || /[\0\r\n]/.test(path) || Buffer.byteLength(path) > 4096) throw fail("Safe file changes require an absolute remote path (or ~/…), at most 4096 bytes and without newline/NUL characters.", "INVALID_PATH");
    return posix.normalize(path);
  }
  async function applyLocked({ host, path, exec, toolName, transform, createDirs, verifyCommand, verifyTimeout, expectedVersion, guardContext }) {
    const signal = exec?.signal;
    const before = await snapshot(host, path, signal);
    const beforeVersion = fileVersion(before);
    if (expectedVersion !== undefined && beforeVersion !== expectedVersion) throw fail("Current file differs from the recorded changed version; refusing to restore over external changes.", "VERSION_CONFLICT");
    const transformed = transform(before);
    const content = Buffer.from(transformed.content);
    if (content.length > maxReadBytes) throw fail("New file exceeds the configured safe-change size limit.", "FILE_TOO_LARGE");
    const metadata = transformed.metadata ?? before ?? {};
    const planned = { content, mode: metadata.mode, uid: metadata.uid, gid: metadata.gid };
    await authorize({ toolName, exec, host, path, guardContext, preview: changePreview(path, before?.content ?? Buffer.alloc(0), content) });
    if (verifyCommand) await verify({ host, exec, command: verifyCommand, timeoutMs: verifyTimeout, authorizeOnly: true, toolName, guardContext });
    signal?.throwIfAborted();
    // Created files have no original to restore. A missing backup service is allowed only for creation.
    let backupId = null;
    if (before || store.available) {
      backupId = await store.save({ binding: hostBinding(host), path, existed: before !== null,
        content: before?.content.toString("base64") ?? null,
        mode: before?.mode, uid: before?.uid, gid: before?.gid,
        beforeVersion, expectedVersion: fileVersion(planned) }, signal);
    }
    const change = { backupId, beforeVersion, afterVersion: null, writeAttempted: false };
    try {
      const checked = await snapshot(host, path, signal);
      if (fileVersion(checked) !== beforeVersion) throw fail("Remote file changed while awaiting approval; read again and request a new approval.", "VERSION_CONFLICT");
      signal?.throwIfAborted();
      if (beforeWrite) await beforeWrite({ host, path, exec, toolName, guardContext });
      signal?.throwIfAborted();
      change.writeAttempted = true;
      const options = { signal, createDirs: createDirs === true };
      for (const key of ["mode", "uid", "gid"]) if (Number.isInteger(planned[key])) options[key] = planned[key];
      const written = await transport.writeFile(host, path, content, options);
      // Read back to catch lost updates / unexpected metadata; never blindly retry a mutation.
      const after = await snapshot(host, path, signal);
      change.afterVersion = fileVersion(after);
      if (!after || !after.content.equals(content) || (before && change.afterVersion !== fileVersion(planned))) {
        throw fail("Post-write file or metadata differs from the planned change; inspect before recovery.", "POST_WRITE_MISMATCH");
      }
      if (verifyCommand) {
        change.verification = { status: "unknown", exitCode: null, timedOut: false };
        try { change.verification = await verify({ host, exec, command: verifyCommand, timeoutMs: verifyTimeout, toolName, guardContext }); }
        catch (error) {
          change.verification.status = error.name === "AbortError" ? "cancelled" : "unknown";
          throw error;
        }
        if (change.verification.status !== "passed") throw fail("File changed but verification did not pass; no reload or automatic restore was performed.", change.verification.timedOut ? "VERIFICATION_TIMEOUT" : change.verification.status === "unknown" ? "VERIFICATION_UNKNOWN" : "VERIFICATION_FAILED");
      }
      return { host: host.name, path, bytesWritten: written?.bytesWritten ?? content.length, created: before === null, ...change, ...(Number.isInteger(planned.mode) ? { mode: planned.mode } : {}), ...(transformed.replacements === undefined ? {} : { replacements: transformed.replacements }) };
    } catch (error) {
      if (!(error instanceof Error)) error = fail("File change failed with an unknown error.", "FILE_CHANGE_FAILED");
      error.change = change;
      // Tool hosts do not necessarily render custom Error properties; surface only recovery IDs/facts.
      error.message += ` [Recovery: backupId=${change.backupId ?? "none (new file has no original)"}; beforeVersion=${change.beforeVersion}; afterVersion=${change.afterVersion ?? "unknown"}; writeAttempted=${change.writeAttempted}. Inspect current state; remote_restore requires approval and version checks.]`;
      throw error;
    }
  }
  async function change(options) {
    const path = targetPath(options.path);
    const target = JSON.stringify([options.host.host, options.host.port ?? 22, options.host.username ?? null, path]);
    return serializeTarget(`file-target:${target}`, () => applyLocked({ ...options, path }), options.exec?.signal);
  }
  async function restore({ host, backupId, ...options }) {
    const record = await store.load(backupId, options.exec?.signal);
    if (record.binding !== hostBinding(host)) throw fail("Backup is bound to a different host/connection; refusing restore.", "BACKUP_HOST_MISMATCH");
    if (record.existed === false) throw fail("This backup describes a newly created file; there is no original to restore. Deletion requires a separate explicit operation.", "NO_ORIGINAL_FILE");
    if (record.existed !== true || !validMetadata(record) || typeof record.content !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.expectedVersion) || !/^[a-f0-9]{64}$/.test(record.beforeVersion)) throw fail("Invalid backup contents or metadata.", "INVALID_BACKUP");
    const content = Buffer.from(record.content, "base64");
    if (content.length > maxReadBytes || content.toString("base64") !== record.content) throw fail("Invalid or oversized backup contents.", "INVALID_BACKUP");
    if (fileVersion({ content, mode: record.mode, uid: record.uid, gid: record.gid }) !== record.beforeVersion) throw fail("Backup checksum mismatch; refusing to restore corrupted content or metadata.", "INVALID_BACKUP");
    return change({ ...options, host, path: record.path, expectedVersion: record.expectedVersion,
      transform: () => ({ content, metadata: record }), toolName: "remote_restore" });
  }
  return { change, restore };
}
