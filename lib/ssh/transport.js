/**
 * SSH transport: pooled ssh2 connections, per-host serialization, exec and
 * SFTP primitives.
 *
 * ```js
 * import { createSshTransport } from "./ssh/transport.js";
 * const transport = createSshTransport({ connectTimeoutMs, idleMs, knownHostsPolicy, knownHostsPath, logger });
 * ```
 *
 * Pooling contract (docs/ARCHITECTURE.md):
 * - one `ssh2.Client` per `host.id` + resolved-auth fingerprint (including any
 *   ProxyJump hop), reused across operations;
 * - idle clients are closed after `idleMs` (default 60 000 ms; 0 = close
 *   immediately after each operation, negative = never close);
 * - one channel per `exec`, one SFTP channel per `withSftp` call;
 * - operations for the same host are serialized (FIFO) so one host never runs
 *   concurrent channels from this plugin;
 * - a channel-level failure discards the pooled client and retries once on a
 *   fresh connection.
 */

import { targetLabel } from './auth.js'
import { isClientUsable, openSession, resolveSessionAuth } from './connection.js'
import { isChannelFailure, RemoteFsError, SshError, throwIfAborted } from './errors.js'
import { composeCommand, runExec } from './exec.js'
import { createKnownHosts } from './known-hosts.js'
import {
  createPtySession,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  DEFAULT_PTY_TERM,
  openShellChannel,
} from './pty.js'
import {
  chmodRemote,
  closeSftpQuietly,
  homeDirRemote,
  listDirRemote,
  mkdirpRemote,
  openSftpChannel,
  readFileRemote,
  statRemote,
  writeFileRemote,
} from './sftp.js'

/**
 * @typedef {import('./exec.js').ExecResult} ExecResult
 * @typedef {import('./sftp.js').RemoteStat} RemoteStat
 * @typedef {import('./sftp.js').RemoteDirEntry} RemoteDirEntry
 * @typedef {import('./pty.js').PtySession} PtySession
 */

const DEFAULTS = Object.freeze({
  connectTimeoutMs: 20_000,
  idleMs: 60_000,
  execTimeoutMs: 120_000,
  maxOutputBytes: 200_000,
  maxReadBytes: 800_000,
})

/**
 * @typedef {object} Entry
 * @property {string} poolKey
 * @property {string} hostId
 * @property {string} target
 * @property {import('ssh2').Client} client
 * @property {import('ssh2').Client[]} jumpClients
 * @property {any} auth
 * @property {number} inUse
 * @property {NodeJS.Timeout|null} idleTimer
 * @property {string|null} homeDirCache
 * @property {string|undefined} warning
 * @property {string[]} warnings
 * @property {boolean} dead
 */

/**
 * @param {unknown} logger
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function makeLogger(logger) {
  const source = logger && typeof logger === 'object' ? /** @type {any} */ (logger) : {}
  const bind = (level) => (...args) => {
    const fn = source[level]
    if (typeof fn !== 'function') return
    try {
      fn.apply(source, args)
    } catch {
      // Logging must never break the transport.
    }
  }
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

/** @param {unknown} value @param {number} fallback */
function boundedNonNegative(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback
}

/**
 * @param {any} host
 * @returns {string}
 */
function hostIdOf(host) {
  return String(host?.id ?? host?.name ?? host?.host ?? '')
}

/**
 * @param {any} host
 */
function assertHost(host) {
  if (!host || typeof host !== 'object') {
    throw new TypeError('SSH transport: a host object is required')
  }
  if (typeof host.host !== 'string' || !host.host.trim()) {
    throw new TypeError(`SSH transport: host "${host?.name ?? host?.id ?? '?'}" has no hostname`)
  }
}

/**
 * Create an SSH transport. See the module docstring for the pooling contract.
 *
 * @param {object} [options]
 * @param {number} [options.connectTimeoutMs=20000]
 * @param {number} [options.idleMs=60000]
 * @param {"tofu"|"strict"|"insecure"} [options.knownHostsPolicy="tofu"]
 * @param {string} [options.knownHostsPath] default `$DSH_HOME/remote/known-hosts.json`
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @param {number} [options.execTimeoutMs=120000]  default exec timeout
 * @param {number} [options.maxOutputBytes=200000] default per-stream output cap
 * @param {number} [options.maxReadBytes=800000]   default readFile cap
 * @param {NodeJS.ProcessEnv} [options.env]        env source for secrets (tests)
 * @param {string} [options.homeDir]               home for `~` expansion (tests)
 */
export function createSshTransport(options = {}) {
  const connectTimeoutMs = positiveNumber(options.connectTimeoutMs, DEFAULTS.connectTimeoutMs)
  const idleMs = Number.isFinite(Number(options.idleMs)) ? Math.floor(Number(options.idleMs)) : DEFAULTS.idleMs
  const execTimeoutMs = positiveNumber(options.execTimeoutMs, DEFAULTS.execTimeoutMs)
  const maxOutputBytes = boundedNonNegative(options.maxOutputBytes, DEFAULTS.maxOutputBytes)
  const maxReadBytes = boundedNonNegative(options.maxReadBytes, DEFAULTS.maxReadBytes)
  const log = makeLogger(options.logger)
  const knownHosts = createKnownHosts({
    policy: options.knownHostsPolicy ?? 'tofu',
    filePath: options.knownHostsPath,
    logger: log,
  })
  const authOptions = {
    env: options.env ?? process.env,
    homeDir: options.homeDir,
    fs: options.fs,
    logger: log,
  }

  /** @type {Map<string, Entry>} */
  const pool = new Map()
  /** @type {Map<string, Promise<void>>} per-host serialization queues */
  const queues = new Map()
  let disposed = false

  const disposedError = () => new SshError('SSH transport has been disposed', 'CONNECT')

  /* ---------------------------------------------------------------- */
  /* Per-host serialization                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Run `task` after all previously queued tasks for `hostId` settle.
   *
   * @template T
   * @param {string} hostId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(hostId, task) {
    const previous = queues.get(hostId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(hostId, tail)
    tail.then(() => {
      if (queues.get(hostId) === tail) queues.delete(hostId)
    })
    return run
  }

  /* ---------------------------------------------------------------- */
  /* Pool lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  /** @param {Entry} entry */
  function clearIdle(entry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  /**
   * @param {Entry} entry
   * @param {{ endClient?: boolean }} [flags]
   */
  function disposeEntry(entry, flags = {}) {
    if (!entry) return
    entry.dead = true
    clearIdle(entry)
    if (pool.get(entry.poolKey) === entry) pool.delete(entry.poolKey)
    for (const jump of entry.jumpClients) {
      try {
        jump.end()
      } catch {
        // ignore
      }
    }
    entry.jumpClients.length = 0
    if (flags.endClient !== false) {
      try {
        entry.client.end()
      } catch {
        // ignore
      }
      try {
        const sock = /** @type {any} */ (entry.client)._sock
        sock?.destroy?.()
      } catch {
        // ignore
      }
    }
  }

  /** @param {Entry} entry */
  function scheduleIdle(entry) {
    if (disposed || entry.dead || entry.inUse > 0) return
    if (idleMs < 0) return
    clearIdle(entry)
    if (idleMs === 0) {
      disposeEntry(entry)
      return
    }
    const timer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.inUse > 0 || entry.dead) return
      log.debug?.(`[dsh-remote] closing idle SSH connection to ${entry.target}`)
      disposeEntry(entry)
    }, idleMs)
    timer.unref?.()
    entry.idleTimer = timer
  }

  /**
   * @param {string} poolKey
   * @param {any} host
   * @param {{ client: import('ssh2').Client, jumpClients: import('ssh2').Client[], warnings: string[] }} session
   * @param {any} auth
   * @returns {Entry}
   */
  function createEntry(poolKey, host, session, auth) {
    /** @type {Entry} */
    const entry = {
      poolKey,
      hostId: hostIdOf(host),
      target: targetLabel(host, auth?.username),
      client: session.client,
      jumpClients: session.jumpClients ?? [],
      auth,
      inUse: 0,
      idleTimer: null,
      homeDirCache: null,
      warning: session.warnings?.[0],
      warnings: session.warnings ?? [],
      dead: false,
    }
    session.client.on('close', () => {
      disposeEntry(entry, { endClient: false })
    })
    session.client.on('end', () => {
      disposeEntry(entry, { endClient: false })
    })
    session.client.on('error', (error) => {
      if (entry.dead) return
      log.debug?.(`[dsh-remote] pooled SSH connection to ${entry.target} failed: ${error instanceof Error ? error.message : String(error)}`)
      disposeEntry(entry, { endClient: false })
    })
    return entry
  }

  /**
   * Get (or open) the pooled authenticated client for `host`. Increments the
   * in-use counter; callers must call {@link releaseEntry} in a `finally`.
   *
   * @param {any} host
   * @param {{ signal?: AbortSignal, connectTimeoutMs?: number }} [opts]
   * @returns {Promise<Entry>}
   */
  async function acquireEntry(host, opts = {}) {
    assertHost(host)
    if (disposed) throw disposedError()
    throwIfAborted(opts.signal)

    const resolved = await resolveSessionAuth(host, authOptions)
    const poolKey = `${hostIdOf(host)}\u0000${resolved.fingerprint}`

    // Drop entries for the same host whose auth fingerprint changed.
    for (const [key, entry] of [...pool]) {
      if (entry.hostId === hostIdOf(host) && key !== poolKey) disposeEntry(entry)
    }

    let entry = pool.get(poolKey)
    if (entry && (entry.dead || !isClientUsable(entry.client))) {
      disposeEntry(entry)
      entry = undefined
    }
    if (!entry) {
      const session = await openSession(host, resolved, {
        connectTimeoutMs: positiveNumber(opts.connectTimeoutMs, connectTimeoutMs),
        verifyHostKey: (targetHost, rawKey) => knownHosts.check(targetHost, rawKey),
        signal: opts.signal,
        logger: log,
      })
      entry = createEntry(poolKey, host, session, resolved.auth)
      entry.fingerprint = resolved.fingerprint
      pool.set(poolKey, entry)
      log.debug?.(`[dsh-remote] opened SSH connection to ${entry.target} (${resolved.auth.method})`)
    }
    entry.inUse += 1
    clearIdle(entry)
    return entry
  }

  /** @param {Entry|undefined|null} entry */
  function releaseEntry(entry) {
    if (!entry) return
    entry.inUse = Math.max(0, entry.inUse - 1)
    if (entry.inUse === 0) scheduleIdle(entry)
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Run a non-interactive remote command.
   *
   * @param {any} host
   * @param {{ command: string, workdir?: string, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, pty?: boolean }} execOptions
   * @returns {Promise<ExecResult>}
   */
  async function exec(host, execOptions = {}) {
    const command = execOptions.command
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('transport.exec: options.command must be a non-empty string')
    }
    const signal = execOptions.signal
    const composed = composeCommand(command, execOptions.workdir)
    const timeoutMs = positiveNumber(execOptions.timeoutMs, execTimeoutMs)
    const maxBytes = boundedNonNegative(execOptions.maxBytes, maxOutputBytes)
    const wantPty = execOptions.pty === true

    return enqueue(hostIdOf(host), async () => {
      if (disposed) throw disposedError()
      throwIfAborted(signal)

      /** @returns {Promise<ExecResult>} */
      const attempt = async (attemptNumber) => {
        const entry = await acquireEntry(host, { signal })
        try {
          const result = await runExec(entry.client, composed, { timeoutMs, maxBytes, signal, pty: wantPty })
          if (entry.warning) result.warning = entry.warning
          return result
        } catch (error) {
          if (isChannelFailure(error)) disposeEntry(entry)
          throw error
        } finally {
          releaseEntry(entry)
        }
      }

      try {
        return await attempt(1)
      } catch (error) {
        if (!isChannelFailure(error)) throw error
        throwIfAborted(signal)
        log.warn?.(`[dsh-remote] channel failure on ${targetLabel(host)}; retrying once on a fresh connection`)
        return attempt(2)
      }
    })
  }

  /**
   * Probe a host (connect + authenticate). Never throws for connection
   * failures; returns `{ ok: false, error }` instead.
   *
   * @param {any} host
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [probeOptions]
   * @returns {Promise<{ ok: boolean, latencyMs: number, error?: Error, warning?: string }>}
   */
  async function test(host, probeOptions = {}) {
    const startedAt = Date.now()
    const latency = () => Math.max(0, Date.now() - startedAt)
    try {
      assertHost(host)
      const warning = await enqueue(hostIdOf(host), async () => {
        if (disposed) throw disposedError()
        const entry = await acquireEntry(host, { signal: probeOptions.signal, connectTimeoutMs: probeOptions.timeoutMs })
        try {
          return entry.warning
        } finally {
          releaseEntry(entry)
        }
      })
      const result = { ok: true, latencyMs: latency() }
      if (warning) result.warning = warning
      return result
    } catch (error) {
      return {
        ok: false,
        latencyMs: latency(),
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /**
   * Run `fn(sftp, host)` with a dedicated SFTP channel. Serialized per host;
   * retries once on a channel/connection failure.
   *
   * @template T
   * @param {any} host
   * @param {(sftp: any, host: any) => Promise<T>|T} fn
   * @param {{ signal?: AbortSignal }} [sftpOptions]
   * @returns {Promise<T>}
   */
  async function withSftp(host, fn, sftpOptions = {}) {
    if (typeof fn !== 'function') throw new TypeError('transport.withSftp: fn must be a function')
    return runSftpTask(host, (sftp) => fn(sftp, host), { signal: sftpOptions.signal })
  }

  /**
   * Queued SFTP task with one channel per attempt and one retry on
   * channel-level failure.
   *
   * @template T
   * @param {any} host
   * @param {(sftp: any, entry: Entry) => Promise<T>|T} fn
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<T>}
   */
  async function runSftpTask(host, fn, opts = {}) {
    assertHost(host)
    const signal = opts.signal
    return enqueue(hostIdOf(host), async () => {
      if (disposed) throw disposedError()
      throwIfAborted(signal)
      let retried = false
      for (;;) {
        const entry = await acquireEntry(host, { signal })
        /** @type {any} */
        let sftp = null
        try {
          sftp = await openSftpChannel(entry.client, { signal, timeoutMs: connectTimeoutMs })
          return await fn(sftp, entry)
        } catch (error) {
          if (isChannelFailure(error) && !retried) {
            retried = true
            log.warn?.(`[dsh-remote] SFTP channel failure on ${entry.target}; retrying once on a fresh connection`)
            disposeEntry(entry)
            continue
          }
          throw error
        } finally {
          if (sftp) closeSftpQuietly(sftp)
          releaseEntry(entry)
        }
      }
    })
  }

  /**
   * Read a remote file (up to `maxBytes`).
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {{ maxBytes?: number, signal?: AbortSignal }} [readOptions]
   * @returns {Promise<{ content: Buffer, size: number, truncated: boolean }>}
   */
  async function readFile(host, remotePath, readOptions = {}) {
    const maxBytes = boundedNonNegative(readOptions.maxBytes, maxReadBytes)
    const signal = readOptions.signal
    return runSftpTask(host, (sftp) => readFileRemote(sftp, remotePath, { maxBytes, signal }), { signal })
  }

  /**
   * Write a remote file atomically (temp file + rename).
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {Buffer|string|Uint8Array} content
   * @param {{ mode?: number, createDirs?: boolean, signal?: AbortSignal }} [writeOptions]
   * @returns {Promise<{ bytesWritten: number }>}
   */
  async function writeFile(host, remotePath, content, writeOptions = {}) {
    const signal = writeOptions.signal
    return runSftpTask(
      host,
      (sftp) =>
        writeFileRemote(sftp, remotePath, content, {
          mode: writeOptions.mode,
          createDirs: writeOptions.createDirs === true,
          signal,
        }),
      { signal },
    )
  }

  /**
   * Stat a remote path (lstat semantics; symlinks reported as `symlink`).
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {{ signal?: AbortSignal }} [statOptions]
   * @returns {Promise<RemoteStat>}
   */
  async function stat(host, remotePath, statOptions = {}) {
    const signal = statOptions.signal
    return runSftpTask(host, (sftp) => statRemote(sftp, remotePath, { signal }), { signal })
  }

  /**
   * List a remote directory.
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {{ signal?: AbortSignal }} [listOptions]
   * @returns {Promise<RemoteDirEntry[]>}
   */
  async function listDir(host, remotePath, listOptions = {}) {
    const signal = listOptions.signal
    return runSftpTask(host, (sftp) => listDirRemote(sftp, remotePath, { signal }), { signal })
  }

  /**
   * `mkdir -p` on the remote host.
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {{ signal?: AbortSignal }} [mkdirOptions]
   * @returns {Promise<void>}
   */
  async function mkdirp(host, remotePath, mkdirOptions = {}) {
    const signal = mkdirOptions.signal
    return runSftpTask(host, (sftp) => mkdirpRemote(sftp, remotePath, { signal }), { signal })
  }

  /**
   * `chmod` a remote path.
   *
   * @param {any} host
   * @param {string} remotePath
   * @param {number} mode
   * @param {{ signal?: AbortSignal }} [chmodOptions]
   * @returns {Promise<void>}
   */
  async function chmod(host, remotePath, mode, chmodOptions = {}) {
    const signal = chmodOptions.signal
    return runSftpTask(host, (sftp) => chmodRemote(sftp, remotePath, mode, { signal }), { signal })
  }

  /**
   * Remote user's home directory, resolved once per pooled connection and
   * cached. Uses SFTP `REALPATH "."` with an exec `$HOME` fallback.
   *
   * @param {any} host
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [homeOptions]
   * @returns {Promise<string>}
   */
  async function homeDir(host, homeOptions = {}) {
    const signal = homeOptions.signal
    return runSftpTask(
      host,
      async (sftp, entry) => {
        if (entry.homeDirCache) return entry.homeDirCache
        try {
          const dir = await homeDirRemote(sftp, { signal })
          entry.homeDirCache = dir
          return dir
        } catch (error) {
          if (isChannelFailure(error)) throw error
          log.debug?.(`[dsh-remote] SFTP REALPATH "." failed on ${entry.target}; falling back to exec "$HOME"`)
          const result = await runExec(entry.client, 'printf %s "$HOME"', {
            timeoutMs: positiveNumber(homeOptions.timeoutMs, 5_000),
            maxBytes: 4_096,
            signal,
          })
          const dir = result.stdout.trim()
          if (!dir.startsWith('/')) {
            throw new RemoteFsError(
              `homeDir failed: could not resolve the remote home directory (exit ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ''})`,
              'SFTP_ERROR',
              { action: 'homeDir' },
            )
          }
          entry.homeDirCache = dir
          return dir
        }
      },
      { signal },
    )
  }

  /**
   * Open an interactive PTY shell on the pooled connection.
   *
   * The borrowed pooled client stays usable: closing the returned session only
   * closes its channel. While the session is open the pooled connection is
   * pinned (it will not idle-close). Aborting `signal` before the channel opens
   * rejects with the canonical `AbortError`; a channel-level open failure
   * discards the pooled client and retries once on a fresh connection (the
   * shell is never duplicated because the retry only happens when no channel
   * was opened).
   *
   * @param {any} host
   * @param {{ term?: string, cols?: number, rows?: number, signal?: AbortSignal }} [ptyOptions]
   * @returns {Promise<PtySession>}
   */
  async function openPty(host, ptyOptions = {}) {
    assertHost(host)
    const signal = ptyOptions.signal
    const term = typeof ptyOptions.term === 'string' && ptyOptions.term.trim() ? ptyOptions.term.trim() : DEFAULT_PTY_TERM
    const cols = positiveNumber(ptyOptions.cols, DEFAULT_PTY_COLS)
    const rows = positiveNumber(ptyOptions.rows, DEFAULT_PTY_ROWS)

    return enqueue(hostIdOf(host), async () => {
      if (disposed) throw disposedError()
      throwIfAborted(signal)
      let retried = false
      for (;;) {
        const entry = await acquireEntry(host, { signal })
        let stream
        try {
          stream = await openShellChannel(entry.client, {
            term,
            cols,
            rows,
            signal,
            timeoutMs: connectTimeoutMs,
          })
        } catch (error) {
          releaseEntry(entry)
          if (isChannelFailure(error) && !retried) {
            retried = true
            throwIfAborted(signal)
            log.warn?.(`[dsh-remote] PTY channel failure on ${entry.target}; retrying once on a fresh connection`)
            disposeEntry(entry)
            continue
          }
          throw error
        }
        // The session owns the in-use reference until its channel closes.
        try {
          return createPtySession({
            stream,
            host: host?.name ?? host?.id ?? String(host?.host ?? ''),
            term,
            cols,
            rows,
            logger: log,
            release: () => releaseEntry(entry),
          })
        } catch (error) {
          try {
            stream.close?.()
          } catch {
            // ignore
          }
          releaseEntry(entry)
          throw error
        }
      }
    })
  }

  /**
   * Close every pooled connection. Idempotent; later operations reject with
   * `SshError` code `CONNECT` ("transport disposed").
   */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const entry of [...pool.values()]) disposeEntry(entry)
    pool.clear()
    queues.clear()
  }

  return {
    // Public contract (docs/ARCHITECTURE.md)
    exec,
    test,
    withSftp,
    readFile,
    writeFile,
    stat,
    listDir,
    mkdirp,
    chmod,
    homeDir,
    openPty,
    dispose,
    // Diagnostics (additive, safe to ignore)
    knownHostsPolicy: knownHosts.policy,
    knownHostsPath: knownHosts.filePath,
    /** @returns {number} number of pooled (possibly idle) connections */
    get poolSize() {
      return pool.size
    },
    /** @returns {boolean} */
    get isDisposed() {
      return disposed
    },
    /** @param {any} host @returns {Promise<string>} */
    targetLabel(host) {
      return targetLabel(host)
    },
  }
}
