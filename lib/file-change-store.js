import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORDS = 1000;
const MAX_DISK_BYTES = 64 * 1024 * 1024;
const locks = new Map();

/** Process-wide serialization, shared across tool sets. External writers are not locked. */
export async function serializeTarget(key, fn, signal) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const tail = new Promise((r) => { release = r; });
  const queued = previous.catch(() => {}).then(() => tail);
  locks.set(key, queued);
  try {
    await new Promise((resolveWait, rejectWait) => {
      const onAbort = () => { cleanup(); rejectWait(signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" })); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.catch(() => {}).then(() => { cleanup(); resolveWait(); });
    });
    signal?.throwIfAborted();
    return await fn();
  } finally {
    release();
    // An aborted queued caller must not release the preceding writer's lock.
    queued.then(() => { if (locks.get(key) === queued) locks.delete(key); });
  }
}

/** Local backups are private, bounded, immutable single-record files. No credentials are stored. */
export function createBackupStore(root, maxBytes) {
  const directory = typeof root === "string" && root.trim() ? resolve(root) : null;
  async function ready() {
    if (!directory) throw Object.assign(new Error("backupRoot is unavailable; refusing to overwrite without a durable backup."), { code: "BACKUP_UNAVAILABLE" });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Backup root must be a real directory, not a symlink.");
    await chmod(directory, 0o700);
  }
  async function save(record, signal) {
    await ready();
    return serializeTarget(`backup-store:${directory}`, async () => {
      signal?.throwIfAborted();
      const files = await readdir(directory);
      let bytes = 0;
      for (const file of files) bytes += (await lstat(join(directory, file))).size;
      const id = randomUUID();
      const text = JSON.stringify({ ...record, schema: 1, backupId: id, time: Date.now() });
      if (files.length >= MAX_RECORDS || bytes + Buffer.byteLength(text) > MAX_DISK_BYTES) {
        throw Object.assign(new Error("Backup capacity reached; archive backups before further changes."), { code: "BACKUP_CAPACITY" });
      }
      const handle = await open(join(directory, `${id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        signal?.throwIfAborted();
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      const dirHandle = await open(directory, constants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      return id;
    }, signal);
  }
  async function load(id, signal) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid backup_id.");
    await ready();
    signal?.throwIfAborted();
    const handle = await open(join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes * 2 + 16384) throw new Error("Invalid or oversized backup record.");
      const record = JSON.parse(await handle.readFile("utf8"));
      if (record.schema !== 1 || record.backupId !== id || typeof record.binding !== "string" || typeof record.path !== "string") throw new Error("Invalid backup record.");
      return record;
    } finally { await handle.close(); }
  }
  return { save, load, available: directory !== null };
}
