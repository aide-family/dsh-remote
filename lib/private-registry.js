import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function registryError(message, code) { return Object.assign(new Error(message), { code }); }

/** Private bounded single-file storage for operator settings. */
export function createPrivateRegistryFile({ root, filename, empty, validate, maxBytes = 8 * 1024 * 1024 }) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('Registry root is required.');
  if (typeof filename !== 'string' || !/^[a-z][a-z0-9-]*\.json$/.test(filename) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new TypeError('Invalid private registry filename or capacity.');
  const directory = resolve(root), path = join(directory, filename), lockPath = join(directory, '.registry.lock');
  async function ready() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw registryError('Registry root must be a real directory.', 'REGISTRY_UNSAFE');
    await chmod(directory, 0o700);
  }
  async function read() {
    await ready();
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw registryError('Registry file is invalid or oversized.', 'REGISTRY_INVALID');
      return validate(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
  }
  async function mutate(fn) {
    await ready();
    let lock;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw registryError('Registry is busy; inspect and stop the writer before removing a stale lock.', 'REGISTRY_BUSY'); throw error; }
    const lockInfo = await lock.stat();
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() }));
      await lock.sync(); await lock.close(); lock = null;
      const current = await read();
      const result = await fn(current);
      const content = JSON.stringify(validate(current));
      if (Buffer.byteLength(content) > maxBytes) throw registryError('Registry storage capacity reached; existing records are not pruned automatically.', 'REGISTRY_CAPACITY');
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
      await handle.close();
      try {
        try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw registryError('Unsafe registry destination.', 'REGISTRY_UNSAFE'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(temporary, path);
        const dir = await open(directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return structuredClone(result);
    } finally {
      if (lock) await lock.close();
      const info = await lstat(lockPath);
      if (info.ino !== lockInfo.ino || info.dev !== lockInfo.dev || !info.isFile() || info.isSymbolicLink()) throw registryError('Registry lock ownership changed.', 'REGISTRY_LOCK_LOST');
      await unlink(lockPath);
    }
  }
  return { read, mutate };
}
