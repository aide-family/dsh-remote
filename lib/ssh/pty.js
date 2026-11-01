/**
 * Interactive PTY channels (v0.2 of dsh-remote).
 *
 * `transport.openPty(host, options)` borrows the pooled `ssh2.Client`, opens one
 * `shell` channel with a requested pseudo-terminal, and returns a
 * {@link PtySession} handle:
 *
 * ```js
 * const pty = await transport.openPty(host, { cols: 120, rows: 40 });
 * const off = pty.onData((text) => process.stdout.write(text));
 * pty.write('echo hi\r');
 * pty.resize(160, 40);
 * pty.signal('INT');
 * const exit = await pty.close(); // idempotent; channel-only
 * ```
 *
 * The session is independent of the pooled connection: closing it only closes
 * the channel, so the same connection keeps serving exec/SFTP operations.
 *
 * Signal caveat: SSH signal requests are fire-and-forget (no reply), so a
 * server that ignores them cannot be detected. `INT` falls back to writing
 * `"\x03"` when the request cannot be sent, and `TSTP` always uses the
 * `"\x1a"` fallback because ssh2's protocol signal allow-list has no `TSTP`.
 */

import { StringDecoder } from 'node:string_decoder'
import { abortError, SshError } from './errors.js'

/** Signals accepted by {@link PtySession.signal}. */
export const PTY_SIGNALS = Object.freeze(['INT', 'TERM', 'KILL', 'TSTP', 'HUP'])

export const DEFAULT_PTY_TERM = 'xterm-256color'
export const DEFAULT_PTY_COLS = 120
export const DEFAULT_PTY_ROWS = 40

const DEFAULT_OPEN_TIMEOUT_MS = 20_000
const CLOSE_EVENT_TIMEOUT_MS = 5_000

/**
 * @typedef {object} PtyExitInfo
 * @property {number|null} code      remote exit code (null when signalled/unknown)
 * @property {string|null} signal    exit signal name (e.g. "SIGINT"), null otherwise
 */

/**
 * @typedef {object} PtyStatusRunning
 * @property {"running"} kind
 *
 * @typedef {object} PtyStatusExited
 * @property {"exited"} kind
 * @property {number|null} exitCode
 * @property {string|null} signal
 *
 * @typedef {PtyStatusRunning|PtyStatusExited} PtyStatus
 */

/**
 * @typedef {object} PtySession
 * @property {string} host                     host name/id for diagnostics
 * @property {string} term
 * @property {number} cols
 * @property {number} rows
 * @property {boolean} closed
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(name: "INT"|"TERM"|"KILL"|"TSTP"|"HUP") => void} signal
 * @property {(cb: (text: string) => void) => () => void} onData
 * @property {(cb: (info: PtyExitInfo) => void) => () => void} onExit
 * @property {() => PtyStatus} status
 * @property {(reason?: string) => Promise<void>} close
 */

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function termString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * Normalize a signal name to the bare form ssh2 expects (`SIGINT`/`int` → `INT`).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizePtySignal(name) {
  return String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/^SIG/, '')
}

/**
 * Open one interactive shell channel with a PTY on an authenticated client.
 * Aborting `signal` before the channel opens rejects with the canonical
 * `AbortError`; a late channel is closed instead of leaked.
 *
 * @param {import('ssh2').Client} client
 * @param {object} [options]
 * @param {string} [options.term]
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<import('ssh2').ClientChannel>}
 */
export function openShellChannel(client, options = {}) {
  const term = termString(options.term, DEFAULT_PTY_TERM)
  const cols = positiveInt(options.cols, DEFAULT_PTY_COLS)
  const rows = positiveInt(options.rows, DEFAULT_PTY_ROWS)
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_OPEN_TIMEOUT_MS)
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
    /** @param {unknown} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    // Deliberately referenced: an unref'd timer could let the process exit
    // while a caller still awaits this promise.
    timer = setTimeout(() => {
      fail(new SshError(`Opening PTY shell channel timed out after ${timeoutMs}ms`, 'TIMEOUT'))
    }, timeoutMs)
    if (signal) {
      onAbort = () => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      client.shell({ term, cols, rows }, (/** @type {any} */ error, /** @type {any} */ stream) => {
        if (settled) {
          try {
            stream?.close?.()
            stream?.destroy?.()
          } catch {
            // ignore
          }
          return
        }
        if (error || !stream) {
          fail(
            new SshError(
              `Could not open PTY shell channel: ${error instanceof Error ? error.message : String(error ?? 'unknown error')}`,
              'CONNECT',
              { cause: error, channelFailure: true },
            ),
          )
          return
        }
        settled = true
        cleanup()
        resolve(stream)
      })
    } catch (error) {
      fail(
        new SshError(
          `Could not open PTY shell channel: ${error instanceof Error ? error.message : String(error)}`,
          'CONNECT',
          { cause: error, channelFailure: true },
        ),
      )
    }
  })
}

/**
 * Wrap an opened shell channel in a {@link PtySession}.
 *
 * @param {object} options
 * @param {import('ssh2').ClientChannel} options.stream
 * @param {string} [options.host]
 * @param {string} [options.term]
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @param {() => void} [options.release] released exactly once when the channel closes
 * @param {{ debug?: Function, warn?: Function }} [options.logger]
 * @returns {PtySession}
 */
export function createPtySession(options) {
  const stream = /** @type {any} */ (options.stream)
  const log = options.logger && typeof options.logger === 'object' ? options.logger : {}
  const host = options.host ?? ''
  const term = termString(options.term, DEFAULT_PTY_TERM)
  const cols = positiveInt(options.cols, DEFAULT_PTY_COLS)
  const rows = positiveInt(options.rows, DEFAULT_PTY_ROWS)
  const release = typeof options.release === 'function' ? options.release : () => {}

  /** @type {Set<(text: string) => void>} */
  const dataListeners = new Set()
  /** @type {Set<(info: PtyExitInfo) => void>} */
  const exitListeners = new Set()
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')

  let released = false
  let exited = false
  let closed = false
  /** @type {PtyExitInfo|null} */
  let exitInfo = null
  /** @type {Promise<void>|null} */
  let closePromise = null
  /** @type {(() => void)|null} */
  let closeResolve = null
  /** @type {NodeJS.Timeout|null} */
  let closeTimer = null
  let bytesReceived = 0

  const releaseOnce = () => {
    if (released) return
    released = true
    try {
      release()
    } catch (error) {
      log.debug?.(`[dsh-remote] PTY release failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @param {string} text */
  const emitData = (text) => {
    if (!text) return
    bytesReceived += Buffer.byteLength(text)
    for (const listener of [...dataListeners]) {
      try {
        listener(text)
      } catch (error) {
        log.warn?.(`[dsh-remote] PTY data listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** @param {unknown} chunk */
  const onStdout = (chunk) => {
    if (closed) return
    emitData(stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
  }
  /** @param {unknown} chunk */
  const onStderr = (chunk) => {
    if (closed) return
    emitData(stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
  }

  /** @param {PtyExitInfo} info */
  const finish = (info) => {
    if (exited) return
    exited = true
    closed = true
    exitInfo = info
    const flushed = stdoutDecoder.end()
    if (flushed) emitData(flushed)
    const flushedErr = stderrDecoder.end()
    if (flushedErr) emitData(flushedErr)
    for (const listener of [...exitListeners]) {
      try {
        listener(info)
      } catch (error) {
        log.warn?.(`[dsh-remote] PTY exit listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    exitListeners.clear()
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    releaseOnce()
    if (closeResolve) {
      const resolve = closeResolve
      closeResolve = null
      resolve()
    }
  }

  stream.on('data', onStdout)
  if (stream.stderr && typeof stream.stderr.on === 'function') stream.stderr.on('data', onStderr)
  stream.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signalName) => {
    exitInfo = {
      code: typeof code === 'number' ? code : null,
      signal: typeof signalName === 'string' && signalName ? signalName : null,
    }
  })
  stream.on('error', (error) => {
    log.debug?.(`[dsh-remote] PTY channel error for ${host}: ${error instanceof Error ? error.message : String(error)}`)
  })
  stream.on('close', () => {
    finish(exitInfo ?? { code: null, signal: null })
  })

  const isClosed = () => closed || closePromise !== null

  /** @type {PtySession} */
  const session = {
    host,
    term,
    cols,
    rows,
    get closed() {
      return closed
    },
    get bytesReceived() {
      return bytesReceived
    },
    /**
     * @param {string} data
     */
    write(data) {
      if (isClosed()) throw new Error('PTY session is closed')
      const text = typeof data === 'string' ? data : String(data ?? '')
      if (!text) return
      stream.write(text)
    },
    /**
     * Best-effort window change; never throws.
     *
     * @param {number} nextCols
     * @param {number} nextRows
     */
    resize(nextCols, nextRows) {
      const width = positiveInt(nextCols, 0)
      const height = positiveInt(nextRows, 0)
      if (!width || !height || isClosed()) return
      try {
        stream.setWindow(height, width, 0, 0)
      } catch (error) {
        log.debug?.(`[dsh-remote] PTY resize failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    /**
     * Send a signal to the remote shell. `TSTP` always uses the `"\x1a"`
     * fallback (ssh2 cannot send it); `INT` falls back to `"\x03"` when the
     * request cannot be sent. Fire-and-forget: an ignored request is invisible.
     *
     * @param {"INT"|"TERM"|"KILL"|"TSTP"|"HUP"|string} name
     */
    signal(name) {
      const normalized = normalizePtySignal(name)
      if (!PTY_SIGNALS.includes(/** @type {any} */ (normalized))) {
        throw new TypeError(`Unsupported PTY signal: ${String(name)}`)
      }
      if (isClosed()) return
      if (normalized === 'TSTP') {
        try {
          stream.write('\x1a')
        } catch (error) {
          log.debug?.(`[dsh-remote] PTY signal fallback failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      try {
        stream.signal(normalized)
      } catch (error) {
        log.debug?.(`[dsh-remote] PTY signal ${normalized} request failed: ${error instanceof Error ? error.message : String(error)}`)
        if (normalized === 'INT') {
          try {
            stream.write('\x03')
          } catch (writeError) {
            log.debug?.(`[dsh-remote] PTY INT fallback failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
          }
        }
      }
    },
    /**
     * @param {(text: string) => void} cb
     * @returns {() => void}
     */
    onData(cb) {
      if (typeof cb !== 'function') throw new TypeError('onData requires a function')
      dataListeners.add(cb)
      return () => {
        dataListeners.delete(cb)
      }
    },
    /**
     * Register an exit listener. Fires exactly once; if the channel already
     * exited when registered it is invoked on a microtask.
     *
     * @param {(info: PtyExitInfo) => void} cb
     * @returns {() => void}
     */
    onExit(cb) {
      if (typeof cb !== 'function') throw new TypeError('onExit requires a function')
      if (exited) {
        const info = exitInfo ?? { code: null, signal: null }
        queueMicrotask(() => {
          try {
            cb(info)
          } catch (error) {
            log.warn?.(`[dsh-remote] PTY exit listener failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
        return () => {}
      }
      exitListeners.add(cb)
      return () => {
        exitListeners.delete(cb)
      }
    },
    /** @returns {PtyStatus} */
    status() {
      if (exited) {
        return {
          kind: 'exited',
          exitCode: exitInfo?.code ?? null,
          signal: exitInfo?.signal ?? null,
        }
      }
      return { kind: 'running' }
    },
    /**
     * Close only this channel (idempotent) and wait for its `close` event.
     *
     * @param {string} [reason]
     * @returns {Promise<void>}
     */
    close(reason) {
      if (closePromise) return closePromise
      if (exited) return Promise.resolve()
      closePromise = new Promise((resolve) => {
        closeResolve = resolve
      })
      log.debug?.(`[dsh-remote] closing PTY session ${host}${reason ? ` (${reason})` : ''}`)
      try {
        stream.end?.()
      } catch {
        // ignore
      }
      try {
        stream.close?.()
      } catch {
        // ignore
      }
      closeTimer = setTimeout(() => {
        closeTimer = null
        try {
          stream.destroy?.()
        } catch {
          // ignore
        }
        log.debug?.(`[dsh-remote] PTY session ${host} did not close in time; destroyed channel`)
        finish(exitInfo ?? { code: null, signal: null })
      }, CLOSE_EVENT_TIMEOUT_MS)
      return closePromise
    },
  }
  return session
}
