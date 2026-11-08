/**
 * SFTP primitives used by the transport: read/write/stat/list/mkdirp/chmod and
 * home-directory resolution. Every helper maps raw ssh2 SFTP errors through
 * {@link mapSftpError} so callers only ever see {@link RemoteFsError}.
 *
 * All helpers are abort-aware: they check the AbortSignal before each network
 * request and between read/write chunks (see "prefer polling aborts" in the
 * architecture doc).
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  abortError,
  mapSftpError,
  RemoteFsError,
  SshError,
  throwIfAborted,
} from './errors.js'

const READ_CHUNK = 64 * 1024
const WRITE_CHUNK = 64 * 1024
const DEFAULT_READ_MAX_BYTES = 800_000
const DEFAULT_SFTP_TIMEOUT_MS = 20_000

// POSIX file-type masks (node:fs constants are not needed for these few bits).
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/**
 * @typedef {"file"|"dir"|"symlink"|"other"} RemoteEntryType
 * @typedef {object} RemoteStat
 * @property {RemoteEntryType} type
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} mode        full POSIX st_mode (type bits included)
 * @property {string} modeString  `ls -l`-style permission string
 * @property {string} [target]    symlink target when cheaply available
 * @typedef {RemoteStat & { name: string }} RemoteDirEntry
 */

/* ------------------------------------------------------------------ */
/* Low-level callback wrappers                                        */
/* ------------------------------------------------------------------ */

/**
 * Wrap one ssh2 SFTP callback method. Returns the first non-error callback
 * argument (or the array of arguments for multi-value callbacks).
 *
 * @param {any} sftp
 * @param {string} method
 * @param {any[]} args
 * @returns {Promise<any>}
 */
function rawCall(sftp, method, args) {
  return new Promise((resolve, reject) => {
    const fn = sftp?.[method]
    if (typeof fn !== 'function') {
      reject(new Error(`SFTP method ${method} is not available`))
      return
    }
    try {
      fn.call(sftp, ...args, (/** @type {any} */ error, /** @type {any[]} */ ...rest) => {
        if (error) {
          reject(error)
          return
        }
        resolve(rest.length <= 1 ? rest[0] : rest)
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * @param {any} sftp
 * @param {string} method
 * @param {any[]} args
 * @param {{ path?: string, action?: string }} [context]
 * @returns {Promise<any>}
 */
async function call(sftp, method, args, context = {}) {
  try {
    return await rawCall(sftp, method, args)
  } catch (error) {
    throw mapSftpError(error, context.path, context.action ?? method)
  }
}

/* ------------------------------------------------------------------ */
/* Channel lifecycle                                                  */
/* ------------------------------------------------------------------ */

/**
 * Open one SFTP channel on an authenticated client (one channel per
 * `withSftp` call, per the transport contract).
 *
 * @param {import('ssh2').Client} client
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>} SFTPWrapper
 */
export function openSftpChannel(client, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SFTP_TIMEOUT_MS
  const signal = options.signal
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    /** @type {NodeJS.Timeout|null} */
    let timer = null
    /** @type {null | (() => void)} */
    let onAbort = null
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal && onAbort) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          // ignore
        }
        onAbort = null
      }
    }
    const fail = (/** @type {unknown} */ error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    timer = setTimeout(() => {
      fail(new SshError(`Opening SFTP channel timed out after ${timeoutMs}ms`, 'TIMEOUT'))
    }, timeoutMs)
    timer.unref?.()
    if (signal) {
      onAbort = () => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      client.sftp((/** @type {any} */ error, /** @type {any} */ sftp) => {
        if (settled) {
          try {
            sftp?.end?.()
          } catch {
            // ignore
          }
          return
        }
        if (error || !sftp) {
          fail(
            new SshError(
              `Could not open SFTP channel: ${error instanceof Error ? error.message : String(error ?? 'unknown error')}`,
              'CONNECT',
              { cause: error, channelFailure: true },
            ),
          )
          return
        }
        settled = true
        cleanup()
        resolve(sftp)
      })
    } catch (error) {
      fail(
        new SshError(
          `Could not open SFTP channel: ${error instanceof Error ? error.message : String(error)}`,
          'CONNECT',
          { cause: error, channelFailure: true },
        ),
      )
    }
  })
}

/**
 * @param {any} sftp
 */
export function closeSftpQuietly(sftp) {
  if (!sftp) return
  try {
    sftp.end()
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* Path/stat helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalize a remote POSIX path: collapse duplicate slashes and trailing
 * slashes (except for "/").
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRemotePath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return raw
  const normalized = path.posix.normalize(raw)
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1)
  return normalized
}

/**
 * @param {string} value
 * @returns {string}
 */
export function remoteDirname(value) {
  const normalized = normalizeRemotePath(value)
  const dir = path.posix.dirname(normalized)
  return dir === '.' ? '/' : dir
}

/**
 * @param {string} value
 * @returns {string}
 */
export function remoteBasename(value) {
  return path.posix.basename(normalizeRemotePath(value))
}

/**
 * @param {number} mode
 * @param {RemoteEntryType} type
 * @returns {string}
 */
export function formatMode(mode, type) {
  const marker = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : type === 'file' ? '-' : '?'
  /** @type {string[]} */
  const chars = [marker]
  const bits = [
    [0o400, 'r'],
    [0o200, 'w'],
    [0o100, 'x'],
    [0o040, 'r'],
    [0o020, 'w'],
    [0o010, 'x'],
    [0o004, 'r'],
    [0o002, 'w'],
    [0o001, 'x'],
  ]
  for (const [bit, char] of bits) chars.push(mode & bit ? char : '-')
  // setuid/setgid/sticky presentation is intentionally simple: swap the x slots.
  if (mode & 0o4000) chars[3] = mode & 0o100 ? 's' : 'S'
  if (mode & 0o2000) chars[6] = mode & 0o010 ? 's' : 'S'
  if (mode & 0o1000) chars[9] = mode & 0o001 ? 't' : 'T'
  return chars.join('')
}

/**
 * @param {any} stats ssh2 Stats instance
 * @returns {RemoteEntryType}
 */
function typeOfStats(stats) {
  if (typeof stats?.isDirectory === 'function') {
    if (stats.isDirectory()) return 'dir'
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isFile()) return 'file'
    return 'other'
  }
  const mode = Number(stats?.mode) || 0
  const fmt = mode & S_IFMT
  if (fmt === S_IFDIR) return 'dir'
  if (fmt === S_IFLNK) return 'symlink'
  if (fmt === S_IFREG) return 'file'
  return 'other'
}

/**
 * @param {any} stats
 * @returns {RemoteStat}
 */
function describeStats(stats) {
  const mode = typeof stats?.mode === 'number' ? stats.mode : 0
  const type = typeOfStats(stats)
  const mtime = Number(stats?.mtime)
  return {
    type,
    size: Number(stats?.size) || 0,
    mtimeMs: Number.isFinite(mtime) && mtime > 0 ? Math.round(mtime * 1000) : 0,
    mode,
    ...(Number.isSafeInteger(stats?.uid) && stats.uid >= 0 ? { uid: stats.uid } : {}),
    ...(Number.isSafeInteger(stats?.gid) && stats.gid >= 0 ? { gid: stats.gid } : {}),
    modeString: formatMode(mode, type),
  }
}

/* ------------------------------------------------------------------ */
/* SFTP operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Stat a remote path using lstat semantics, so symlinks are reported as
 * `type: "symlink"` (with a best-effort `target`).
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<RemoteStat>}
 */
export async function statRemote(sftp, remotePath, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath) || '/'
  const stats = await call(sftp, 'lstat', [target], { path: target, action: 'stat' })
  const info = describeStats(stats)
  if (info.type === 'symlink') {
    try {
      throwIfAborted(options.signal)
      const linked = await rawCall(sftp, 'readlink', [target])
      if (typeof linked === 'string' && linked) info.target = linked
    } catch {
      // Reading the link target is best effort.
    }
  }
  return info
}

/**
 * Directory listing. Symlinks are reported as `symlink` (lstat semantics).
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<RemoteDirEntry[]>}
 */
export async function listDirRemote(sftp, remotePath, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath) || '/'
  const list = await call(sftp, 'readdir', [target], { path: target, action: 'list' })
  if (!Array.isArray(list)) {
    throw new RemoteFsError(`list failed: unexpected SFTP response for ${JSON.stringify(target)}`, 'SFTP_ERROR', { path: target, action: 'list' })
  }
  /** @type {RemoteDirEntry[]} */
  const entries = []
  for (const item of list) {
    const name = typeof item?.filename === 'string' ? item.filename : ''
    if (!name || name === '.' || name === '..') continue
    const info = describeStats(item?.attrs ?? {})
    entries.push({ name, ...info })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/**
 * Read up to `maxBytes` from a remote file.
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ content: Buffer, size: number, truncated: boolean }>}
 */
export async function readFileRemote(sftp, remotePath, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath)
  if (!target) throw new RemoteFsError('read failed: empty remote path', 'SFTP_ERROR', { path: target, action: 'read' })
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(0, Math.floor(Number(options.maxBytes))) : DEFAULT_READ_MAX_BYTES

  /** @type {any} */
  let handle = null
  try {
    handle = await call(sftp, 'open', [target, 'r'], { path: target, action: 'read' })
    let size = 0
    try {
      const stats = await rawCall(sftp, 'fstat', [handle])
      size = Number(stats?.size) || 0
    } catch {
      size = 0
    }
    if (maxBytes <= 0) {
      return { content: Buffer.alloc(0), size, truncated: size > 0 }
    }
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    while (total < maxBytes) {
      throwIfAborted(options.signal)
      const want = Math.min(READ_CHUNK, maxBytes - total)
      const buffer = Buffer.allocUnsafe(want)
      const reply = await rawCall(sftp, 'read', [handle, buffer, 0, want, total])
      const bytesRead = Array.isArray(reply) ? Number(reply[0]) : Number(reply)
      if (!bytesRead || bytesRead <= 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      if (bytesRead < want) break
    }
    const content = Buffer.concat(chunks, total)
    const truncated = size > 0 ? size > content.length : content.length >= maxBytes
    return { content, size: Math.max(size, content.length), truncated }
  } catch (error) {
    throw error instanceof RemoteFsError ? error : mapSftpError(error, target, 'read')
  } finally {
    if (handle) {
      try {
        await rawCall(sftp, 'close', [handle])
      } catch {
        // ignore close failures; the channel will be closed by the transport
      }
    }
  }
}

/**
 * Write a remote file atomically: write a temp file in the same directory, then
 * rename it over the destination.
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {Buffer|string|Uint8Array} content
 * @param {{ mode?: number, createDirs?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<{ bytesWritten: number }>}
 */
export async function writeFileRemote(sftp, remotePath, content, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath)
  if (!target || target === '/') {
    throw new RemoteFsError('write failed: invalid remote file path', 'SFTP_ERROR', { path: target || remotePath, action: 'write' })
  }
  const buffer = Buffer.isBuffer(content)
    ? content
    : content instanceof Uint8Array
      ? Buffer.from(content)
      : Buffer.from(String(content ?? ''), 'utf8')
  const dir = remoteDirname(target)
  const base = remoteBasename(target)
  // New files are private by default. Explicit chmod must not bypass the
  // server's umask by widening a newly created configuration to world-writable.
  const mode = Number.isFinite(Number(options.mode)) ? Number(options.mode) & 0o7777 : 0o600

  if (options.createDirs) await mkdirpRemote(sftp, dir, { signal: options.signal })

  const tempPath = path.posix.join(dir, `.${base}.tmp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
  let handle = null
  let renamed = false
  try {
    // Exclusive creation and a private mode prevent exposing partial contents.
    handle = await call(sftp, 'open', [tempPath, 'wx', 0o600], { path: tempPath, action: 'write' })
    let offset = 0
    while (offset < buffer.length) {
      throwIfAborted(options.signal)
      const chunk = buffer.subarray(offset, offset + WRITE_CHUNK)
      await call(sftp, 'write', [handle, chunk, 0, chunk.length, offset], { path: tempPath, action: 'write' })
      offset += chunk.length
    }
    await call(sftp, 'close', [handle], { path: tempPath, action: 'write' })
    handle = null
    throwIfAborted(options.signal)
    // Apply original ownership before mode: chown can clear set-id bits. Avoid
    // unnecessary chown on servers where the temporary file already has the
    // desired owner (ordinary non-root users may not have chown permission).
    if (options.uid !== undefined || options.gid !== undefined) {
      if (!Number.isSafeInteger(options.uid) || options.uid < 0 ||
          !Number.isSafeInteger(options.gid) || options.gid < 0) {
        throw new RemoteFsError('write failed: preserving ownership requires valid uid and gid', 'SFTP_ERROR', { path: target, action: 'write' })
      }
      const attrs = await call(sftp, 'lstat', [tempPath], { path: tempPath, action: 'write' })
      if (attrs.uid !== options.uid || attrs.gid !== options.gid) {
        await call(sftp, 'chown', [tempPath, options.uid, options.gid], { path: tempPath, action: 'write' })
      }
    }
    await call(sftp, 'chmod', [tempPath, mode], { path: tempPath, action: 'write' })
    throwIfAborted(options.signal)
    try {
      await call(sftp, 'rename', [tempPath, target], { path: target, action: 'write' })
    } catch (renameError) {
      // Some SFTP servers refuse RENAME onto an existing file. The OpenSSH
      // posix-rename extension may replace it atomically. Never unlink the
      // destination: a failed second rename would otherwise lose the original.
      let renamedWithExtension = false
      if (typeof sftp.ext_openssh_rename === 'function') {
        try {
          await new Promise((resolve, reject) => {
            sftp.ext_openssh_rename(tempPath, target, (error) => (error ? reject(error) : resolve(undefined)))
          })
          renamedWithExtension = true
        } catch {
          renamedWithExtension = false
        }
      }
      if (!renamedWithExtension) throw renameError
    }
    renamed = true
    return { bytesWritten: buffer.length }
  } catch (error) {
    throw error instanceof RemoteFsError ? error : mapSftpError(error, target, 'write')
  } finally {
    if (handle) {
      try {
        await rawCall(sftp, 'close', [handle])
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      try {
        await rawCall(sftp, 'unlink', [tempPath])
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Recursive `mkdir -p` over SFTP.
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function mkdirpRemote(sftp, remotePath, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath)
  if (!target || target === '/' || target === '.') return
  const absolute = target.startsWith('/')
  const segments = target.split('/').filter((segment) => segment && segment !== '.')
  let current = absolute ? '' : '.'
  for (const segment of segments) {
    if (segment === '..') {
      current = current === '.' ? '..' : path.posix.join(current || '/', segment)
      continue
    }
    current = current === '' ? `/${segment}` : path.posix.join(current, segment)
    throwIfAborted(options.signal)
    let existing = null
    try {
      existing = await call(sftp, 'stat', [current], { path: current, action: 'mkdir' })
    } catch (error) {
      if (!(error instanceof RemoteFsError) || error.code !== 'ENOENT') throw error
    }
    if (existing) {
      if (typeof existing.isDirectory === 'function' && !existing.isDirectory()) {
        throw new RemoteFsError(`mkdir failed: ${JSON.stringify(current)} exists and is not a directory`, 'ENOTDIR', {
          path: current,
          action: 'mkdir',
        })
      }
      continue
    }
    try {
      await call(sftp, 'mkdir', [current, { mode: 0o755 }], { path: current, action: 'mkdir' })
    } catch (error) {
      // A concurrent creator wins the race: accept it when the dir now exists.
      try {
        const stats = await rawCall(sftp, 'stat', [current])
        if (typeof stats?.isDirectory === 'function' && stats.isDirectory()) continue
      } catch {
        // fall through to the original error
      }
      throw error
    }
  }
}

/**
 * `chmod` a remote path.
 *
 * @param {any} sftp
 * @param {string} remotePath
 * @param {number} mode
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function chmodRemote(sftp, remotePath, mode, options = {}) {
  throwIfAborted(options.signal)
  const target = normalizeRemotePath(remotePath)
  const numeric = Number(mode)
  if (!Number.isFinite(numeric)) {
    throw new RemoteFsError(`chmod failed: invalid mode ${String(mode)}`, 'SFTP_ERROR', { path: target, action: 'chmod' })
  }
  await call(sftp, 'chmod', [target, Math.floor(numeric) & 0o7777], { path: target, action: 'chmod' })
}

/**
 * Resolve the SFTP session's home directory via `REALPATH "."` — correct for
 * both password and publickey auth because it is server-side state.
 *
 * @param {any} sftp
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function homeDirRemote(sftp, options = {}) {
  throwIfAborted(options.signal)
  const result = await call(sftp, 'realpath', ['.'], { path: '.', action: 'homeDir' })
  if (typeof result === 'string' && result.startsWith('/')) return normalizeRemotePath(result) || '/'
  throw new RemoteFsError('homeDir failed: SFTP REALPATH returned a non-absolute path', 'SFTP_ERROR', {
    path: '.',
    action: 'homeDir',
  })
}
