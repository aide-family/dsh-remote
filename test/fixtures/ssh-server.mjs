/**
 * Real ssh2 `Server` fixture for dsh-remote tests.
 *
 * One async factory, exact export shape consumed by integration/e2e tests:
 *
 * ```js
 * import { startSshServer } from "../fixtures/ssh-server.mjs";
 * const srv = await startSshServer();
 * // srv = {
 * //   host: "127.0.0.1",
 * //   port: number,                    // actual bound ephemeral port
 * //   username: "testuser",            // accepted login user (both auth methods)
 * //   password: "testpass",            // accepted password
 * //   privateKeyPath: string,          // generated ed25519 private key file (mode 0600)
 * //   publicKey: string,               // matching "ssh-ed25519 AAAA... comment" line
 * //   rootDir: string,                 // SFTP root + exec cwd (fresh temp dir)
 * //   hostKeyFingerprint: string,      // "SHA256:<base64>" of the server host key
 * //   async close(): Promise<void>,    // stop listener, end connections, remove temp dirs
 * //   // Extra diagnostics/methods (additive):
 * //   connectionCount: number,         // currently open connections
 * //   connectionTotal: number,         // total connections accepted so far
 * //   execCommands: string[],          // recently received exec command lines
 * //   shellSessions: Array<{term, cols, rows, windows, signals,
 * //                         startedAt, closedAt, exitCode, signal}>,
 * //   shellTotal: number,              // shell channels opened so far
 * //   shellCount: number,              // currently open shell channels
 * //   failNextExec(): void,            // reject the next exec channel (retry tests)
 * // }
 * ```
 *
 * Options: `{ rootDir?, port?, username?, password?, banner?, hostKey?, authorizedKeys? }`
 * - `authorizedKeys`: extra OpenSSH public key lines accepted for publickey auth
 *   (in addition to the generated client key) — used for passphrase/default-key
 *   tests.
 * - `hostKey`: private key material for the server (default: generated ed25519).
 *
 * Semantics:
 * - exec runs `/bin/sh -c <command>` with cwd = `rootDir` and `HOME=rootDir`;
 *   stdout/stderr/exit status/signals are forwarded to the SSH channel, and
 *   closing the channel kills the child process.
 * - SFTP serves `rootDir`: absolute paths under `rootDir` are used as-is, other
 *   absolute paths are treated as chroot-relative, relative paths resolve
 *   against `rootDir`, and escaping paths are rejected with
 *   `SSH_FX_PERMISSION_DENIED`.
 * - Supports OPEN/READ/WRITE/CLOSE/REALPATH/STAT/LSTAT/FSTAT/READDIR/OPENDIR/
 *   MKDIR/RENAME/RMDIR/REMOVE(UNLINK)/CHMOD(SETSTAT)/FSETSTAT/READLINK/SYMLINK.
 * - `shell` channels: `/bin/sh -i` in `rootDir` with `HOME=rootDir` and the
 *   requested `TERM`, using an ssh2-style PTY emulation over pipes (no native
 *   PTY dependency). Data is forwarded both ways, CR is translated to NL, the
 *   tty line discipline is emulated for `\x03` (INT), `\x1a` (TSTP) and
 *   `\x04` (EOF), window changes are recorded (`shellSessions[].windows`) and
 *   a SIGWINCH is delivered, channel signal requests are forwarded to the
 *   child process group, the child is killed when the channel closes, and the
 *   exit status is forwarded. `printf 'fixture-shell-ready\n'` runs on startup
 *   so there is deterministic initial output.
 *
 * Nothing is left behind after `close()` (listener, connections, temp dirs).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE, flagsToString } = utils.sftp

/** @typedef {import('ssh2').Server} SshServer */

/**
 * Generate a key pair that ssh2 can actually parse.
 *
 * ssh2 1.17.0 occasionally emits a malformed OpenSSH ed25519 private key
 * (~0.5% of calls, "Malformed OpenSSH private key string"). Retrying keeps the
 * fixture deterministic for the whole suite.
 *
 * @param {'ed25519'|'ecdsa'|'rsa'} type
 * @param {object} [options]
 * @returns {{ private: string, public: string }}
 */
function generateUsableKeyPair(type, options = {}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair = utils.generateKeyPairSync(type, options)
    try {
      const privateKey = utils.parseKey(pair.private, options?.passphrase)
      const publicKey = utils.parseKey(pair.public)
      if (
        privateKey &&
        typeof privateKey.getPublicSSH === 'function' &&
        publicKey &&
        typeof publicKey.getPublicSSH === 'function'
      ) {
        return pair
      }
    } catch {
      // malformed pair: retry
    }
  }
  throw new Error(`startSshServer: could not generate a usable ${type} key pair`)
}

/**
 * @typedef {object} FixtureServer
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} password
 * @property {string} privateKeyPath
 * @property {string} publicKey
 * @property {string} rootDir
 * @property {string} hostKeyFingerprint
 * @property {number} connectionCount
 * @property {number} connectionTotal
 * @property {string[]} execCommands
 * @property {Array<any>} shellSessions
 * @property {number} shellTotal
 * @property {number} shellCount
 * @property {(command?: string) => void} failNextExec
 * @property {() => Promise<void>} close
 */

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]       serve an existing directory (not removed on close)
 * @param {number} [options.port]          listen port, default 0 (ephemeral)
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {string} [options.banner]        SSH pre-auth banner
 * @param {Buffer|string} [options.hostKey] server host private key (default: generated ed25519)
 * @returns {Promise<FixtureServer>}
 */
export async function startSshServer(options = {}) {
  const username = options.username ?? 'testuser'
  const password = options.password ?? 'testpass'
  const host = '127.0.0.1'

  // --- directories ---------------------------------------------------------
  /** @type {string[]} */
  const ownedDirs = []
  let rootDir
  if (options.rootDir) {
    rootDir = path.resolve(options.rootDir)
    await fsp.mkdir(rootDir, { recursive: true })
  } else {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-remote-fixture-root-'))
    ownedDirs.push(rootDir)
  }
  rootDir = await fsp.realpath(rootDir)

  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-remote-fixture-state-'))
  ownedDirs.push(stateDir)

  // --- host key / client key ----------------------------------------------
  const hostKeyMaterial = options.hostKey ?? generateUsableKeyPair('ed25519').private
  const parsedHostKey = utils.parseKey(hostKeyMaterial)
  if (!parsedHostKey || typeof parsedHostKey.getPublicSSH !== 'function') {
    throw new Error('startSshServer: options.hostKey is not a usable private key')
  }
  // parseKey(privateKey) re-derives the public key blob, which is exactly what
  // OpenSSH hashes for a SHA256 fingerprint.
  const hostPublicBlob = parsedHostKey.getPublicSSH()
  const hostKeyFingerprint = `SHA256:${createHash('sha256').update(hostPublicBlob).digest('base64').replace(/=+$/, '')}`

  const clientKeyPair = generateUsableKeyPair('ed25519')
  const clientPublicKey = utils.parseKey(clientKeyPair.public)
  /** @type {any[]} additional authorized public keys (OpenSSH public key lines) */
  const authorizedKeys = [clientPublicKey]
  for (const line of Array.isArray(options.authorizedKeys) ? options.authorizedKeys : []) {
    try {
      const parsed = utils.parseKey(String(line))
      if (parsed && typeof parsed.getPublicSSH === 'function') authorizedKeys.push(parsed)
    } catch {
      // Ignore unusable authorized key entries.
    }
  }
  const privateKeyPath = path.join(stateDir, 'id_ed25519')
  await fsp.writeFile(privateKeyPath, clientKeyPair.private, { mode: 0o600 })

  // --- server state --------------------------------------------------------
  /** @type {Set<any>} */
  const connections = new Set()
  let connectionTotal = 0
  /** @type {string[]} */
  const execCommands = []
  let failNextExecFlag = false
  let failNextExecCommand
  /** @type {Array<any>} */
  const shellSessions = []
  let shellTotal = 0

  /** @param {any} a @param {any} b */
  const safeEqual = (a, b) => {
    const left = Buffer.from(String(a ?? ''))
    const right = Buffer.from(String(b ?? ''))
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  /** @param {number} reqid @param {unknown} error */
  const statusFor = (sftp, reqid, error) => {
    const code = /** @type {any} */ (error)?.code
    if (code === 'ENOENT') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE, 'No such file or directory')
    if (code === 'EACCES') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
    if (code === 'EPERM') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
    if (code === 'ENOTDIR') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Not a directory')
    if (code === 'EISDIR') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Is a directory')
    if (code === 'EEXIST') return sftp.status(reqid, STATUS_CODE.FAILURE, 'File already exists')
    if (code === 'ENOTEMPTY') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Directory not empty')
    return sftp.status(reqid, STATUS_CODE.FAILURE, error instanceof Error ? error.message : String(error))
  }

  /** @param {string} remotePath @returns {string|null} */
  const resolveRemote = (remotePath) => {
    if (typeof remotePath !== 'string' || !remotePath) return null
    const absolute = remotePath.startsWith('/') ? remotePath : `/${remotePath}`
    const normalized = path.posix.normalize(absolute)
    let local
    if (normalized === rootDir) {
      local = rootDir
    } else if (normalized.startsWith(`${rootDir}/`)) {
      // The fixture exposes the real absolute path of rootDir (e.g. macOS temp
      // dirs under /private/var/...), so clients can use it verbatim.
      local = normalized
    } else if (rootDir.startsWith(`${normalized}/`)) {
      // Allow traversing rootDir's ancestors (mkdir -p over an absolute home
      // path must find /private, /private/var, ... already present instead of
      // creating a chroot-relative replica).
      local = normalized
    } else {
      // Chroot-relative: "/etc/foo" means "<rootDir>/etc/foo".
      local = path.join(rootDir, normalized.replace(/^\/+/, ''))
    }
    if (local !== rootDir && !local.startsWith(`${rootDir}${path.sep}`) && !rootDir.startsWith(`${local}${path.sep}`)) {
      return null
    }
    return local
  }

  /** @param {string} local @returns {string} */
  const toRemotePath = (local) => (local === rootDir ? rootDir : local)

  /** @param {any} stats */
  const attrsFromStats = (stats) => ({
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(Number(stats.atimeMs) / 1000),
    mtime: Math.floor(Number(stats.mtimeMs) / 1000),
  })

  /** @param {string} name @param {any} stats */
  const longname = (name, stats) => {
    const mode = Number(stats.mode) || 0
    const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-'
    const perms = formatPerms(mode)
    const mtime = new Date(Number(stats.mtimeMs) || Date.now())
    const stamp = mtime.toDateString().slice(4, 10) + ' ' + mtime.toTimeString().slice(0, 5)
    return `${type}${perms} 1 fixture fixture ${Number(stats.size) || 0} ${stamp} ${name}`
  }

  /** @param {number} mode */
  const formatPerms = (mode) => {
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
    return bits.map(([bit, char]) => (mode & bit ? char : '-')).join('')
  }

  /**
   * Install the SFTP request handlers for one SFTP channel.
   *
   * @param {any} sftp
   */
  const handleSftpChannel = (sftp) => {
    /** @type {Map<number, { kind: 'file'|'dir', handle?: any, path: string, entries?: Array<{ name: string, attrs: any }>, offset?: number }>} */
    const handles = new Map()
    let nextHandle = 0
    /** @param {any} state */
    const allocHandle = (state) => {
      const id = nextHandle++
      handles.set(id, state)
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32BE(id, 0)
      return buffer
    }
    /** @param {Buffer} buffer */
    const getHandle = (buffer) => {
      if (!Buffer.isBuffer(buffer) || buffer.length !== 4) return null
      return handles.get(buffer.readUInt32BE(0)) ?? null
    }
    const closeAll = () => {
      for (const state of handles.values()) {
        if (state.kind === 'file' && state.handle) {
          state.handle.close().catch(() => {})
        }
      }
      handles.clear()
    }
    sftp.on('close', closeAll)

    sftp.on('OPEN', (reqid, filename, flags, attrs) => {
      void (async () => {
        const local = resolveRemote(filename)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        const flagsString = flagsToString(flags)
        if (!flagsString) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Unsupported open flags')
        try {
          const mode = Number.isFinite(attrs?.mode) ? attrs.mode : 0o666
          const handle = await fsp.open(local, flagsString, mode)
          sftp.handle(reqid, allocHandle({ kind: 'file', handle, path: local }))
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('READ', (reqid, handleBuffer, offset, length) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state || state.kind !== 'file' || !state.handle) {
          return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid file handle')
        }
        try {
          const buffer = Buffer.alloc(Math.max(0, Math.min(Number(length) || 0, 1 << 20)))
          const { bytesRead } = await state.handle.read(buffer, 0, buffer.length, Number(offset) || 0)
          if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF)
          sftp.data(reqid, buffer.subarray(0, bytesRead))
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('WRITE', (reqid, handleBuffer, offset, data) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state || state.kind !== 'file' || !state.handle) {
          return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid file handle')
        }
        try {
          const payload = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '')
          await state.handle.write(payload, 0, payload.length, Number(offset) || 0)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('CLOSE', (reqid, handleBuffer) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid handle')
        handles.delete(handleBuffer.readUInt32BE(0))
        try {
          if (state.kind === 'file' && state.handle) await state.handle.close()
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('OPENDIR', (reqid, remotePath) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          const stats = await fsp.stat(local)
          if (!stats.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Not a directory')
          const dirents = await fsp.readdir(local, { withFileTypes: true })
          /** @type {Array<{ name: string, attrs: any }>} */
          const entries = []
          const selfStats = await fsp.lstat(local)
          entries.push({ name: '.', attrs: attrsFromStats(selfStats) })
          const parentStats = await fsp.stat(path.join(local, '..'))
          entries.push({ name: '..', attrs: attrsFromStats(parentStats) })
          for (const dirent of dirents) {
            const entryPath = path.join(local, dirent.name)
            try {
              const entryStats = await fsp.lstat(entryPath)
              entries.push({ name: dirent.name, attrs: attrsFromStats(entryStats) })
            } catch {
              // raced deletion: skip
            }
          }
          sftp.handle(reqid, allocHandle({ kind: 'dir', path: local, entries, offset: 0 }))
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('READDIR', (reqid, handleBuffer) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state || state.kind !== 'dir') {
          return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid directory handle')
        }
        const entries = state.entries ?? []
        const offset = state.offset ?? 0
        if (offset >= entries.length) return sftp.status(reqid, STATUS_CODE.EOF)
        const chunk = entries.slice(offset, offset + 64)
        state.offset = offset + chunk.length
        sftp.name(
          reqid,
          chunk.map((entry) => ({
            filename: entry.name,
            longname: longname(entry.name, entry.attrs),
            attrs: entry.attrs,
          })),
        )
      })()
    })

    const statHandler = (reqid, remotePath, follow) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          const stats = follow ? await fsp.stat(local) : await fsp.lstat(local)
          sftp.attrs(reqid, attrsFromStats(stats))
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    }
    sftp.on('STAT', (reqid, remotePath) => statHandler(reqid, remotePath, true))
    sftp.on('LSTAT', (reqid, remotePath) => statHandler(reqid, remotePath, false))

    sftp.on('FSTAT', (reqid, handleBuffer) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid handle')
        try {
          if (state.kind === 'file' && state.handle) {
            const stats = await state.handle.stat()
            sftp.attrs(reqid, attrsFromStats(stats))
            return
          }
          const stats = await fsp.lstat(state.path)
          sftp.attrs(reqid, attrsFromStats(stats))
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    const applyAttrs = async (local, attrs) => {
      if (!attrs) return
      if (Number.isFinite(attrs.mode)) await fsp.chmod(local, attrs.mode & 0o7777)
      if (Number.isFinite(attrs.uid) || Number.isFinite(attrs.gid)) {
        await fsp.chown(local, Number.isFinite(attrs.uid) ? attrs.uid : -1, Number.isFinite(attrs.gid) ? attrs.gid : -1)
      }
      if (Number.isFinite(attrs.size)) await fsp.truncate(local, attrs.size)
      if (Number.isFinite(attrs.atime) || Number.isFinite(attrs.mtime)) {
        const now = Math.floor(Date.now() / 1000)
        await fsp.utimes(local, Number.isFinite(attrs.atime) ? attrs.atime : now, Number.isFinite(attrs.mtime) ? attrs.mtime : now)
      }
    }

    sftp.on('SETSTAT', (reqid, remotePath, attrs) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          await applyAttrs(local, attrs)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('FSETSTAT', (reqid, handleBuffer, attrs) => {
      void (async () => {
        const state = getHandle(handleBuffer)
        if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Invalid handle')
        try {
          if (state.kind === 'file' && state.handle && Number.isFinite(attrs?.mode)) {
            await state.handle.chmod(attrs.mode & 0o7777)
            sftp.status(reqid, STATUS_CODE.OK)
            return
          }
          await applyAttrs(state.path, attrs)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('REALPATH', (reqid, remotePath) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        let filename
        try {
          filename = local ? await fsp.realpath(local) : null
        } catch {
          filename = local
        }
        if (!filename) {
          const normalized = path.posix.normalize(remotePath?.startsWith('/') ? remotePath : `/${remotePath ?? '.'}`)
          filename = normalized
        }
        sftp.name(reqid, [{ filename: toRemotePath(filename), longname: filename, attrs: {} }])
      })()
    })

    sftp.on('READLINK', (reqid, remotePath) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          const target = await fsp.readlink(local)
          sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }])
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('SYMLINK', (reqid, linkPath, targetPath) => {
      void (async () => {
        const linkLocal = resolveRemote(linkPath)
        if (!linkLocal) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          await fsp.symlink(targetPath, linkLocal)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('MKDIR', (reqid, remotePath, attrs) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          await fsp.mkdir(local, { mode: Number.isFinite(attrs?.mode) ? attrs.mode & 0o7777 : 0o777 })
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('RMDIR', (reqid, remotePath) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          await fsp.rmdir(local)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('REMOVE', (reqid, remotePath) => {
      void (async () => {
        const local = resolveRemote(remotePath)
        if (!local) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        try {
          await fsp.unlink(local)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })

    sftp.on('RENAME', (reqid, oldPath, newPath) => {
      void (async () => {
        const oldLocal = resolveRemote(oldPath)
        const newLocal = resolveRemote(newPath)
        if (!oldLocal || !newLocal) {
          return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Permission denied')
        }
        try {
          await fsp.rename(oldLocal, newLocal)
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (error) {
          statusFor(sftp, reqid, error)
        }
      })()
    })
  }

  // --- server --------------------------------------------------------------
  const server = new Server({ hostKeys: [hostKeyMaterial], ...(options.banner ? { banner: String(options.banner) } : {}) }, (client) => {
    connections.add(client)
    connectionTotal += 1
    client.on('close', () => connections.delete(client))
    client.on('error', () => connections.delete(client))

    client.on('authentication', (ctx) => {
      if (!safeEqual(ctx.username, username)) return ctx.reject(['password', 'publickey'])
      switch (ctx.method) {
        case 'password':
          if (!safeEqual(ctx.password, password)) return ctx.reject(['password', 'publickey'])
          return ctx.accept()
        case 'publickey': {
          const match = authorizedKeys.find(
            (key) => key.type === ctx.key.algo && Buffer.from(ctx.key.data).equals(key.getPublicSSH()),
          )
          if (!match) return ctx.reject(['password', 'publickey'])
          if (ctx.signature) {
            let verified = false
            try {
              verified = match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
            } catch {
              verified = false
            }
            if (!verified) return ctx.reject(['password', 'publickey'])
          }
          return ctx.accept()
        }
        default:
          return ctx.reject(['password', 'publickey'])
      }
    })

    client.on('ready', () => {
      // ProxyJump support: open a real TCP connection on the fixture's behalf.
      client.on('tcpip', (accept, reject, info) => {
        const stream = accept()
        const socket = net.connect({ host: info.destIP, port: info.destPort })
        socket.on('connect', () => {
          socket.pipe(stream)
          stream.pipe(socket)
        })
        socket.on('error', () => {
          try {
            stream.close()
          } catch {
            // ignore
          }
        })
        stream.on('close', () => {
          socket.destroy()
        })
      })
      client.on('session', (accept) => {
        const session = accept()
        /** @type {import('node:child_process').ChildProcess|null} */
        let currentChild = null
        /** @type {'exec'|'shell'|null} */
        let currentMode = null
        /** @type {any} */
        let ptyInfo = null
        /** @type {any} */
        let shellRecord = null
        // PTY requests are accepted; the window info is applied to `shell`
        // channels and ignored by `exec` (which only needs the request to
        // succeed for `pty: true`).
        session.on('pty', (acceptPty, rejectPty, info) => {
          ptyInfo = info ?? null
          try {
            acceptPty?.()
          } catch {
            // ignore
          }
        })
        /** @param {unknown} rawName @returns {string} */
        const signalToKill = (rawName) => {
          const bare = String(rawName ?? '')
            .trim()
            .toUpperCase()
            .replace(/^SIG/, '')
          const allowed = ['INT', 'TERM', 'KILL', 'TSTP', 'HUP', 'QUIT', 'USR1', 'USR2', 'PIPE', 'ALRM', 'ABRT', 'FPE', 'ILL', 'SEGV']
          return `SIG${allowed.includes(bare) ? bare : 'TERM'}`
        }
        /** @param {unknown} rawName */
        const deliverSignal = (rawName) => {
          if (!currentChild) return
          const signalName = signalToKill(rawName)
          if (shellRecord) shellRecord.signals.push(signalName)
          try {
            // Shells run detached (own process group) with job control disabled,
            // so a group signal emulates the terminal driver's Ctrl-C delivery.
            if (currentMode === 'shell') process.kill(-currentChild.pid, signalName)
            else currentChild.kill(signalName)
          } catch {
            try {
              currentChild.kill(signalName)
            } catch {
              // child already gone
            }
          }
        }
        session.on('signal', (acceptSignal, rejectSignal, info) => {
          deliverSignal(info?.name)
          try {
            acceptSignal?.()
          } catch {
            // ignore
          }
        })
        session.on('exec', (acceptExec, rejectExec, info) => {
          const command = typeof info?.command === 'string' ? info.command : ''
          if (failNextExecFlag && (failNextExecCommand === undefined || failNextExecCommand === command)) {
            failNextExecFlag = false
            failNextExecCommand = undefined
            try {
              rejectExec?.()
            } catch {
              // ignore
            }
            return
          }
          execCommands.push(command)
          if (execCommands.length > 100) execCommands.shift()
          const stream = acceptExec()
          const child = spawn('/bin/sh', ['-c', command], {
            cwd: rootDir,
            env: { ...process.env, HOME: rootDir, PWD: rootDir, LC_ALL: 'C', TZ: 'UTC' },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          currentChild = child
          currentMode = 'exec'
          let exited = false
          child.stdout?.on('data', (chunk) => {
            try {
              stream.write(chunk)
            } catch {
              // channel closed
            }
          })
          child.stderr?.on('data', (chunk) => {
            try {
              stream.stderr.write(chunk)
            } catch {
              // channel closed
            }
          })
          child.on('error', (error) => {
            if (exited) return
            exited = true
            try {
              stream.stderr.write(`fixture exec error: ${error instanceof Error ? error.message : String(error)}\n`)
            } catch {
              // ignore
            }
            try {
              stream.exit(127)
              stream.end()
            } catch {
              // ignore
            }
          })
          child.on('exit', (code, signal) => {
            if (exited) return
            exited = true
            try {
              if (signal) stream.exit(signal.toUpperCase().replace(/^SIG/, ''))
              else stream.exit(typeof code === 'number' ? code : 0)
            } catch {
              // ignore
            }
            try {
              stream.end()
            } catch {
              // ignore
            }
          })
          stream.on('close', () => {
            if (!exited) {
              try {
                child.kill('SIGKILL')
              } catch {
                // ignore
              }
            }
          })
        })
        session.on('shell', (acceptShell, rejectShell) => {
          const stream = acceptShell()
          const term = typeof ptyInfo?.term === 'string' && ptyInfo.term ? ptyInfo.term : 'xterm-256color'
          const cols = Number.isFinite(ptyInfo?.cols) ? ptyInfo.cols : 120
          const rows = Number.isFinite(ptyInfo?.rows) ? ptyInfo.rows : 40
          /** @type {any} */
          const record = {
            term,
            cols,
            rows,
            windows: [],
            signals: [],
            startedAt: Date.now(),
            closedAt: null,
            exitCode: null,
            signal: null,
          }
          shellSessions.push(record)
          if (shellSessions.length > 50) shellSessions.shift()
          shellTotal += 1
          shellRecord = record

          // No native PTY dependency: an ssh2-style PTY emulation over pipes.
          // `set +m` disables job control so the foreground command shares the
          // shell's process group and group signals behave like Ctrl-C.
          const child = spawn('/bin/sh', ['-i'], {
            cwd: rootDir,
            env: { ...process.env, HOME: rootDir, PWD: rootDir, TERM: term, LC_ALL: 'C', TZ: 'UTC', PS1: '$ ' },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          })
          currentChild = child
          currentMode = 'shell'
          let exited = false

          child.stdout?.on('data', (chunk) => {
            try {
              stream.write(chunk)
            } catch {
              // channel closed
            }
          })
          child.stderr?.on('data', (chunk) => {
            try {
              stream.write(chunk)
            } catch {
              // channel closed
            }
          })
          // Deterministic startup output + job-control-free foreground jobs.
          try {
            child.stdin.write("set +m\nprintf 'fixture-shell-ready\\n'\n")
          } catch {
            // ignore
          }

          stream.on('data', (chunk) => {
            let input = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
            // Emulate the tty line discipline for the control characters the
            // remote side may send when ssh2 signal requests are unavailable.
            if (input.includes('\x03')) {
              deliverSignal('INT')
              input = input.split('\x03').join('')
            }
            // Ctrl-U erases the currently buffered line in this input chunk.
            // This pipe fixture is not a native tty; reset also uses SIGINT to
            // discard any shell parser state from previously delivered input.
            if (input.includes('\x15')) input = input.replace(/[^\r\n]*\x15/gu, '')
            if (input.includes('\x1a')) {
              deliverSignal('TSTP')
              input = input.split('\x1a').join('')
            }
            if (input.includes('\x04')) {
              try {
                child.stdin.end()
              } catch {
                // ignore
              }
              input = input.split('\x04').join('')
            }
            // A PTY line discipline turns CR into NL; do the same for pipes so
            // `text + "\r"` submissions execute.
            input = input.replace(/\r\n?/g, '\n')
            if (!input) return
            try {
              child.stdin.write(input)
            } catch {
              // shell stdin closed
            }
          })

          session.on('window-change', (acceptWindow, rejectWindow, info) => {
            record.windows.push({ cols: info?.cols ?? null, rows: info?.rows ?? null })
            record.cols = Number.isFinite(info?.cols) ? info.cols : record.cols
            record.rows = Number.isFinite(info?.rows) ? info.rows : record.rows
            try {
              if (!exited) process.kill(-child.pid, 'SIGWINCH')
            } catch {
              // child already gone; window size is still recorded
            }
            try {
              acceptWindow?.()
            } catch {
              // ignore
            }
          })

          child.on('error', (error) => {
            if (exited) return
            exited = true
            record.closedAt = Date.now()
            try {
              stream.write(`fixture shell error: ${error instanceof Error ? error.message : String(error)}\n`)
            } catch {
              // ignore
            }
            try {
              stream.exit(127)
              stream.end()
            } catch {
              // ignore
            }
          })
          child.on('exit', (code, signal) => {
            if (exited) return
            exited = true
            record.exitCode = typeof code === 'number' ? code : null
            record.signal = signal ?? null
            record.closedAt = Date.now()
            currentChild = null
            try {
              if (signal) stream.exit(signal.toUpperCase().replace(/^SIG/, ''))
              else stream.exit(typeof code === 'number' ? code : 0)
            } catch {
              // ignore
            }
            try {
              stream.end()
            } catch {
              // ignore
            }
          })
          stream.on('close', () => {
            record.closedAt = record.closedAt ?? Date.now()
            if (shellRecord === record) shellRecord = null
            if (exited) return
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              try {
                child.kill('SIGKILL')
              } catch {
                // ignore
              }
            }
          })
        })

        session.on('sftp', (acceptSftp) => {
          let sftp
          try {
            sftp = acceptSftp()
          } catch {
            return
          }
          handleSftpChannel(sftp)
        })
      })
    })
  })

  server.on('error', () => {
    // Connection-level errors are surfaced through individual clients; keep the
    // listener process alive for the next test case.
  })

  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  )
  const address = /** @type {net.AddressInfo} */ (server.address())
  const port = address.port

  let closed = false

  /** @type {FixtureServer} */
  const fixture = {
    host,
    port,
    username,
    password,
    privateKeyPath,
    publicKey: clientKeyPair.public,
    rootDir,
    hostKeyFingerprint,
    get connectionCount() {
      return connections.size
    },
    get connectionTotal() {
      return connectionTotal
    },
    execCommands,
    shellSessions,
    get shellTotal() {
      return shellTotal
    },
    get shellCount() {
      return shellSessions.filter((record) => record.closedAt === null).length
    },
    failNextExec(command) {
      if (command !== undefined && (typeof command !== 'string' || command.length === 0)) throw new TypeError('failure target must be a non-empty command')
      failNextExecCommand = command
      failNextExecFlag = true
    },
    async close() {
      if (closed) return
      closed = true
      for (const client of connections) {
        try {
          client.end()
        } catch {
          // ignore
        }
        try {
          client._sock?.destroy?.()
        } catch {
          // ignore
        }
      }
      connections.clear()
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        server.close(() => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      for (const dir of ownedDirs) {
        try {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 })
        } catch {
          // Best effort: a lingering handle on macOS may delay removal; tests
          // clean temp dirs on process exit anyway.
        }
      }
    },
  }
  return fixture
}
