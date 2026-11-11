/**
 * One remote PTY session: startup collection, the exclusive send lifecycle,
 * scrollback reads, signals and quiescent close.
 *
 * The session wraps the transport's `PtySession` handle (contract in
 * docs/ARCHITECTURE.md, "Transport contract addition — interactive PTY
 * channel"):
 *
 * ```js
 * const session = createPtySession({ pty, config, logger })
 * const { motd, status } = await session.start()
 * const operation = session.startSend({ text: "echo hi", submit: true })
 * const { viewport, waitReason, sessionStatus, truncated } = await operation.done
 * session.read({ offset: 0, count: 100 })
 * await session.close("done")
 * ```
 *
 * Readiness is inferred from output silence: a remote shell over an SSH channel
 * does not expose a foreground process group, so "the command finished" means
 * "the channel has been quiet for `terminalIdleSilenceMs` after the write"
 * (`inferred_idle`), "the channel exited" (`session_exit`) or "the absolute
 * `terminalTimeoutMs` elapsed" (`timeout`). Only one send may be active per
 * session; starting another throws an Error with `code === "SEND_ACTIVE"`.
 *
 * A send accepts an optional `onData({ stream: "stdout", chunk })` callback: it
 * receives, in order, every non-empty sanitized chunk the session appends to its
 * scrollback while that send is active (used by the v0.4 live terminal mirror).
 * It is never called after the send settles and its exceptions are swallowed.
 *
 * This module is pure JavaScript: it only imports the pure scrollback helper and
 * the canonical transport error helpers; it never touches @deepseek-ai packages.
 */

import { abortError, throwIfAborted } from '../ssh/errors.js'
import { createScrollback, utf8Tail } from './scrollback.js'

/** Minimum time (ms) the startup collection runs before publishing `motd`. */
export const STARTUP_FLOOR_MS = 250
/** Wait reasons a send can settle with. */
export const WAIT_REASONS = Object.freeze(['inferred_idle', 'timeout', 'session_exit'])
/** Signals accepted by {@link createPtySession} / `signal()` (short ssh2 names). */
export const SIGNAL_NAMES = Object.freeze(['INT', 'TERM', 'KILL', 'TSTP', 'HUP'])

const DEFAULTS = Object.freeze({
  idleSilenceMs: 800,
  startupTimeoutMs: 15_000,
  timeoutMs: 30_000,
  scrollbackLines: 2_000,
  scrollbackBytes: 2_000_000,
  maxReadBytes: 262_144,
})

/** @param {unknown} logger */
function makeLogger(logger) {
  const source = logger && typeof logger === 'object' ? /** @type {any} */ (logger) : {}
  const bind = (level) => (...args) => {
    const fn = source[level]
    if (typeof fn !== 'function') return
    try {
      fn.apply(source, args)
    } catch {
      // Logging must never break the session.
    }
  }
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback
}

/** @param {string} message @param {string} code @returns {Error} */
function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {unknown} status */
function normalizeStatus(status) {
  if (status && typeof status === 'object' && status.kind === 'exited') {
    return {
      kind: 'exited',
      exitCode: Number.isFinite(Number(status.exitCode)) ? Number(status.exitCode) : null,
      signal: typeof status.signal === 'string' ? status.signal : null,
    }
  }
  return { kind: 'running' }
}

/**
 * Normalize a signal name: accepts both POSIX names (`SIGINT`) and ssh2 channel
 * signal names (`INT`).
 *
 * @param {unknown} name
 * @returns {"INT"|"TERM"|"KILL"|"TSTP"|"HUP"}
 */
export function normalizeSignalName(name) {
  const raw = typeof name === 'string' ? name.trim().toUpperCase() : ''
  const short = raw.startsWith('SIG') ? raw.slice(3) : raw
  if (!SIGNAL_NAMES.includes(short)) {
    throw new Error(
      `remote shell signal must be one of ${SIGNAL_NAMES.map((item) => `SIG${item}`).join(', ')} (got ${JSON.stringify(name)})`,
    )
  }
  return /** @type {"INT"|"TERM"|"KILL"|"TSTP"|"HUP"} */ (short)
}

/**
 * Make sanitized terminal text readable in a send viewport: carriage returns and
 * CRLF become newlines, backspaces are dropped and tabs become two spaces. The
 * scrollback ring keeps the exact overwrite semantics for `read()`.
 *
 * @param {string} text
 * @returns {string}
 */
function renderText(text) {
  return text
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .replace(/\u0008/gu, '')
    .replace(/\t/gu, '  ')
}

/**
 * A bounded delta buffer used for one send viewport / `readOutput()` call. The
 * newest bytes are retained; older bytes are dropped and reported as truncated.
 *
 * @param {number} maxBytes
 * @returns {{ append(text: string): void, drain(): { text: string, truncated: boolean } }}
 */
function createDeltaBuffer(maxBytes) {
  const limit = Math.max(1, maxBytes)
  /** @type {string[]} */
  let chunks = []
  let bytes = 0
  let dropped = false
  return {
    append(text) {
      if (!text) return
      chunks.push(text)
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > limit * 2) {
        while (bytes > limit && chunks.length > 1) {
          const first = chunks.shift()
          bytes -= Buffer.byteLength(first, 'utf8')
          dropped = true
        }
      }
    },
    drain() {
      const raw = chunks.join('')
      chunks = []
      bytes = 0
      const tail = utf8Tail(raw, limit)
      const truncated = dropped || tail.truncated
      dropped = false
      return { text: tail.text, truncated }
    },
  }
}

/**
 * Create one remote PTY session around a transport `PtySession` handle.
 *
 * @param {object} options
 * @param {any} options.pty transport PTY handle (`write/resize/signal/onData/onExit/status/close`)
 * @param {object} options.config normalized plugin config (`terminal*` fields)
 * @param {string} [options.initialOutput] prior bounded PTY output to seed when attaching to a shared session
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @returns {{
 *   start(options?: { signal?: AbortSignal }): Promise<{ motd: string, status: object }>,
 *   startSend(options: { text?: string, submit?: boolean, signal?: AbortSignal, onData?: (event: { stream: "stdout", chunk: string }) => void }): {
 *     done: Promise<{ viewport: string, waitReason: string, sessionStatus: object, truncated: boolean }>,
 *     readOutput(): { delta: string, truncated: boolean },
 *     cancel(): boolean,
 *   },
 *   read(options?: { offset?: number, count?: number }): {
 *     text: string, totalLines: number, lineBegin: number, lineEnd: number, truncated: boolean,
 *   },
 *   signal(name: string): Promise<{ delivered: true, targetPgid: number }>,
 *   resize(cols: number, rows: number): void,
 *   status(): { kind: "running" } | { kind: "exited", exitCode: number | null, signal: string | null },
 *   close(reason?: string): Promise<void>,
 *   readonly motd: string,
 * }}
 */
export function createPtySession({ pty, config, initialOutput, logger } = {}) {
  if (!pty || typeof pty !== 'object') throw new TypeError('createPtySession: a transport PTY handle is required')
  for (const method of ['write', 'onData', 'onExit', 'status', 'close']) {
    if (typeof pty[method] !== 'function') {
      throw new TypeError(`createPtySession: PTY handle is missing the "${method}()" method`)
    }
  }
  const log = makeLogger(logger)
  const idleSilenceMs = positiveInt(config?.terminalIdleSilenceMs, DEFAULTS.idleSilenceMs)
  const startupTimeoutMs = positiveInt(config?.terminalStartupTimeoutMs, DEFAULTS.startupTimeoutMs)
  const timeoutMs = positiveInt(config?.terminalTimeoutMs, DEFAULTS.timeoutMs)
  const scrollbackLines = positiveInt(config?.terminalScrollbackLines, DEFAULTS.scrollbackLines)
  const maxReadBytes = positiveInt(config?.terminalMaxReadBytes, DEFAULTS.maxReadBytes)
  // Poll often enough to notice silence promptly without busy-waiting.
  const pollIntervalMs = Math.max(20, Math.min(50, Math.floor(idleSilenceMs / 4)))

  const scrollback = createScrollback({
    maxLines: scrollbackLines,
    maxBytes: positiveInt(config?.terminalScrollbackBytes, DEFAULTS.scrollbackBytes),
  })
  if (typeof initialOutput === 'string' && initialOutput.length > 0) {
    scrollback.append(initialOutput)
  }

  /** @type {{ kind: "running" } | { kind: "exited", exitCode: number | null, signal: string | null }} */
  let statusNow = normalizeStatus(safeStatus())
  let closed = false
  /** @type {Promise<void>|null} */
  let closePromise = null
  let motd = ''
  let started = false
  /** @type {Promise<{ motd: string, status: object }>|null} */
  let startupPromise = null
  /** @type {{ done: boolean, reject: (error: Error) => void }|null} */
  let startup = null
  let lastOutputAt = Date.now()
  /** @type {{ operation: object, state: { settled: boolean }, append: Function, settle: Function, fail: Function }|null} */
  let active = null

  /** @type {null | (() => void)} */
  let detachData = null
  /** @type {null | (() => void)} */
  let detachExit = null

  /** @returns {any} the transport status, or a running fallback when it throws */
  function safeStatus() {
    try {
      return pty.status()
    } catch (error) {
      log.debug?.(`[dsh-remote] PTY status() failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'running' }
    }
  }

  /** @param {string} reason */
  function safeSignal(reason) {
    try {
      pty.signal(normalizeSignalName(reason))
      return true
    } catch (error) {
      log.debug?.(
        `[dsh-remote] PTY signal ${reason} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /** @param {{ code: number|null, signal: string|null }} info */
  function handleExit(info) {
    const exitCode = info && Number.isFinite(Number(info.code)) ? Number(info.code) : null
    const signal = info && typeof info.signal === 'string' ? info.signal : null
    statusNow = { kind: 'exited', exitCode, signal }
    if (startup && !startup.done) {
      startup.reject(
        codedError(
          `remote shell session exited during startup (${exitCode === null ? signal ?? 'unknown' : `exit ${exitCode}`})`,
          'SESSION_EXIT',
        ),
      )
    }
    if (active && !active.state.settled) active.settle('session_exit')
  }

  /** @param {string} text */
  function handleData(text) {
    if (closed) return
    if (typeof text !== 'string' || text.length === 0) return
    const sanitized = scrollback.append(text)
    if (sanitized.length === 0) return
    lastOutputAt = Date.now()
    if (active && !active.state.settled) active.append(sanitized)
  }

  try {
    detachData = pty.onData(handleData)
  } catch (error) {
    log.warn?.(`[dsh-remote] PTY onData subscription failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    detachExit = pty.onExit(handleExit)
  } catch (error) {
    log.warn?.(`[dsh-remote] PTY onExit subscription failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** Bounded sanitized startup output. */
  function readMotd() {
    const page = scrollback.snapshot({ offset: 0, count: scrollbackLines, maxBytes: maxReadBytes })
    return page.text
  }

  /**
   * Collect startup output until output silence (floor 250 ms) or the startup
   * deadline, then publish `motd`. Rejects when the shell exits or the open is
   * aborted during collection.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ motd: string, status: object }>}
   */
  function start(options = {}) {
    if (startupPromise) return startupPromise
    const signal = options.signal
    throwIfAborted(signal)
    if (closed) {
      startupPromise = Promise.reject(codedError('remote shell session is closed', 'SESSION_CLOSED'))
      return startupPromise
    }
    const current = normalizeStatus(safeStatus())
    statusNow = current
    if (current.kind === 'exited') {
      startupPromise = Promise.reject(
        codedError(
          `remote shell session exited before startup (${current.exitCode === null ? current.signal ?? 'unknown' : `exit ${current.exitCode}`})`,
          'SESSION_EXIT',
        ),
      )
      return startupPromise
    }
    started = true
    startupPromise = new Promise((resolve, reject) => {
      const startedAt = Date.now()
      let done = false
      /** @type {NodeJS.Timeout|null} */
      let deadline = null
      /** @type {NodeJS.Timeout|null} */
      let poll = null
      /** @type {null | (() => void)} */
      let detachAbort = null

      const cleanup = () => {
        if (deadline) {
          clearTimeout(deadline)
          deadline = null
        }
        if (poll) {
          clearInterval(poll)
          poll = null
        }
        if (detachAbort) {
          detachAbort()
          detachAbort = null
        }
        startup = null
      }
      const finish = (waitTimedOut) => {
        if (done) return
        done = true
        cleanup()
        const status = normalizeStatus(safeStatus())
        statusNow = status
        motd = readMotd()
        if (waitTimedOut) {
          log.warn?.(`[dsh-remote] remote shell startup collection hit its ${startupTimeoutMs}ms deadline`)
        }
        resolve({ motd, status })
      }
      const fail = (error) => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      }
      startup = { done: false, reject: fail }

      deadline = setTimeout(() => finish(true), startupTimeoutMs)
      poll = setInterval(() => {
        if (done) return
        const now = Date.now()
        if (now - lastOutputAt >= idleSilenceMs && now - startedAt >= STARTUP_FLOOR_MS) {
          finish(false)
        }
      }, pollIntervalMs)

      if (signal) {
        const onAbort = () => fail(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
        detachAbort = () => signal.removeEventListener('abort', onAbort)
      }
    })
    return startupPromise
  }

  /**
   * Build one exclusive send operation.
   *
   * @param {{ text?: string, submit?: boolean, signal?: AbortSignal, onData?: (event: { stream: "stdout", chunk: string }) => void }} request
   */
  function createOperation(request) {
    const text = typeof request.text === 'string' ? request.text : String(request.text ?? '')
    const submit = request.submit !== false
    const signal = request.signal
    /** Optional live-output tap; only functions are accepted, others are ignored. */
    const onData = typeof request.onData === 'function' ? request.onData : null
    const input = `${text}${submit ? '\r' : ''}`
    const isComplete = typeof request.isComplete === 'function' ? request.isComplete : null
    const operationTimeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : timeoutMs
    const outputLimit = Number.isSafeInteger(request.maxBytes) && request.maxBytes > 0 ? Math.min(request.maxBytes, maxReadBytes) : maxReadBytes
    const buffer = createDeltaBuffer(outputLimit)
    const startedAt = Date.now()
    const state = { settled: false }
    let operationLastOutputAt = Date.now()
    /** @type {NodeJS.Timeout|null} */
    let deadline = null
    /** @type {NodeJS.Timeout|null} */
    let poll = null
    /** @type {null | (() => void)} */
    let detachAbort = null
    /** @type {(value: any) => void} */
    let resolveDone = () => {}
    /** @type {(error: Error) => void} */
    let rejectDone = () => {}
    const done = new Promise((resolvePromise, rejectPromise) => {
      resolveDone = resolvePromise
      rejectDone = rejectPromise
    })

    const cleanup = () => {
      if (deadline) {
        clearTimeout(deadline)
        deadline = null
      }
      if (poll) {
        clearInterval(poll)
        poll = null
      }
      if (detachAbort) {
        detachAbort()
        detachAbort = null
      }
    }

    /** @param {string} waitReason */
    const settle = (waitReason) => {
      if (state.settled) return
      state.settled = true
      cleanup()
      const drained = buffer.drain()
      const result = {
        viewport: renderText(drained.text),
        waitReason,
        sessionStatus: normalizeStatus(statusNow),
        truncated: drained.truncated,
      }
      if (active && active.state === state) active = null
      resolveDone(result)
    }

    /** @param {Error} error */
    const fail = (error) => {
      if (state.settled) return
      state.settled = true
      cleanup()
      if (active && active.state === state) active = null
      rejectDone(error)
    }

    const cancel = () => {
      if (state.settled) return false
      safeSignal('INT')
      return true
    }

    const operation = {
      done,
      readOutput() {
        const drained = buffer.drain()
        return { delta: renderText(drained.text), truncated: drained.truncated }
      },
      cancel,
    }

    const internals = {
      operation,
      state,
      append(cleanText) {
        if (state.settled) return
        operationLastOutputAt = Date.now()
        buffer.append(cleanText)
        if (onData !== null) {
          try {
            onData({ stream: 'stdout', chunk: cleanText })
          } catch (error) {
            // A mirror/consumer callback must never break the session or the send.
            log.debug?.(
              `[dsh-remote] remote shell send onData callback failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        if (isComplete !== null) {
          try { if (isComplete() === true) settle('protocol_complete') }
          catch { fail(codedError('verified completion predicate failed', 'PROTOCOL_INVALID')) }
        }
      },
      settle,
      fail,
    }

    // Register as the active operation before writing: a fake/local transport may
    // emit output synchronously from write().
    active = internals

    if (signal) {
      const onAbort = () => {
        if (state.settled) return
        safeSignal('INT')
        fail(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => signal.removeEventListener('abort', onAbort)
    }

    deadline = setTimeout(() => settle('timeout'), operationTimeoutMs)
    poll = setInterval(() => {
      if (state.settled) return
      const now = Date.now()
      if (isComplete === null && now - operationLastOutputAt >= idleSilenceMs) {
        settle('inferred_idle')
        return
      }
      if (now - startedAt >= operationTimeoutMs) settle('timeout')
    }, pollIntervalMs)

    try {
      pty.write(input)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
    return operation
  }

  /**
   * Start one exclusive send. Only one may be active per session; a second call
   * throws an Error with `code === "SEND_ACTIVE"`.
   *
   * `onData`, when provided, is called once per non-empty sanitized output chunk
   * produced while this send is active, as `{ stream: "stdout", chunk }` — the
   * same text the session appends to its scrollback. It is never called after
   * the send settles and its exceptions are swallowed. Startup/motd collection
   * and `readOutput()`/`viewport` semantics are unchanged.
   *
   * @param {{ text?: string, submit?: boolean, signal?: AbortSignal, onData?: (event: { stream: "stdout", chunk: string }) => void }} [request]
   */
  function startSend(request = {}) {
    const signal = request.signal
    throwIfAborted(signal)
    if (closed) throw codedError('remote shell session is closed', 'SESSION_CLOSED')
    if (statusNow.kind === 'exited') {
      throw codedError(
        `remote shell session has exited (${statusNow.exitCode === null ? statusNow.signal ?? 'unknown' : `exit ${statusNow.exitCode}`})`,
        'SESSION_EXIT',
      )
    }
    if (active && !active.state.settled) {
      throw codedError('remote shell session already has an active send', 'SEND_ACTIVE')
    }
    if (active) active = null
    return createOperation({
      text: request.text,
      submit: request.submit,
      signal: signal ?? undefined,
      onData: request.onData,
      isComplete: request.isComplete,
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
    })
  }

  /**
   * Read one newest-relative page of retained scrollback.
   *
   * @param {{ offset?: number, count?: number }} [readOptions]
   */
  function read(readOptions = {}) {
    return scrollback.snapshot({
      offset: readOptions.offset,
      count: readOptions.count,
    })
  }

  /**
   * Deliver one signal to the remote shell. The remote process group id is not
   * exposed over the SSH channel, so `targetPgid` is always 0.
   *
   * @param {string} name
   * @returns {Promise<{ delivered: true, targetPgid: number }>}
   */
  async function signal(name) {
    if (closed) throw codedError('remote shell session is closed', 'SESSION_CLOSED')
    const short = normalizeSignalName(name)
    pty.signal(short)
    return { delivered: true, targetPgid: 0 }
  }

  /**
   * Best-effort window resize for the remote PTY.
   *
   * @param {number} cols
   * @param {number} rows
   */
  function resize(cols, rows) {
    if (closed) throw codedError('remote shell session is closed', 'SESSION_CLOSED')
    if (typeof pty.resize !== 'function') return
    pty.resize(Math.max(1, Math.floor(Number(cols) || 1)), Math.max(1, Math.floor(Number(rows) || 1)))
  }

  /** @returns {{ kind: "running" } | { kind: "exited", exitCode: number | null, signal: string | null }} */
  function status() {
    return normalizeStatus(statusNow)
  }

  /**
   * Close the PTY channel and await quiescence. Idempotent: concurrent/later
   * calls return the same promise. Physical close settles as `session_exit`;
   * retained shared-handle close rejects the send with `SESSION_RELEASED` instead.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  function close(reason = 'closed', { sharedTerminalPreserved = false } = {}) {
    if (closePromise) return closePromise
    closed = true
    if (startup && !startup.done) {
      startup.reject(codedError('remote shell session closed during startup', 'SESSION_CLOSED'))
    }
    closePromise = (async () => {
      /** @type {unknown} */
      let closeError = null
      try {
        await pty.close(reason)
      } catch (error) {
        closeError = error
        log.warn?.(
          `[dsh-remote] PTY close failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (detachData) {
        try {
          detachData()
        } catch {
          // ignore
        }
        detachData = null
      }
      if (detachExit) {
        try {
          detachExit()
        } catch {
          // ignore
        }
        detachExit = null
      }
      if (active && !active.state.settled) {
        if (sharedTerminalPreserved) active.fail(codedError('Agent handle released; shared terminal was not closed and command outcome is unproven', 'SESSION_RELEASED'))
        else active.settle('session_exit')
      }
      if (closeError) throw closeError
    })()
    return closePromise
  }

  return {
    start,
    startSend,
    read,
    signal,
    resize,
    status,
    close,
    get motd() {
      return motd
    },
    get isSending() { return active !== null && !active.state.settled },
    get isClosed() {
      return closed
    },
    get isStarted() {
      return started
    },
  }
}
