/**
 * Non-interactive remote command execution over an ssh2 Client.
 *
 * Semantics (docs/ARCHITECTURE.md):
 * - `code` is the remote exit code; `-1` when killed before exit.
 * - Non-zero exit is a normal result, never an exception.
 * - A timeout resolves with `timedOut: true` and the partial output collected
 *   so far.
 * - An AbortSignal rejects with the canonical `AbortError` and closes the
 *   channel (so the remote process is terminated).
 * - `maxBytes` bounds each stream independently; the TAIL is kept and
 *   `truncated` is set when anything was cut.
 * - `workdir` is applied as `cd <quoted workdir> && <command>`.
 * - Optional `onData({ stream, chunk })` streams decoded UTF-8 text live
 *   (one `StringDecoder` per stream, flushed before settlement, never called
 *   after the promise settles). It never changes the returned result.
 */

import { StringDecoder } from 'node:string_decoder'

import { abortError, SshError } from './errors.js'

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

/**
 * @typedef {"stdout"|"stderr"} ExecStream
 *
 * @typedef {object} ExecDataChunk
 * @property {ExecStream} stream  which stream produced this text
 * @property {string} chunk       decoded UTF-8 text (may be empty only when flushed)
 */

/**
 * @typedef {object} ExecResult
 * @property {number} code             remote exit code, -1 when killed before exit
 * @property {string|null} signal      exit signal name when the remote process was signalled
 * @property {string} stdout           captured stdout (tail when truncated)
 * @property {string} stderr           captured stderr (tail when truncated)
 * @property {number} stdoutBytes      total stdout bytes received (before truncation)
 * @property {number} stderrBytes      total stderr bytes received (before truncation)
 * @property {boolean} truncated       true when either stream was cut
 * @property {boolean} timedOut        true when the local timeout fired
 * @property {number} durationMs       wall-clock duration
 * @property {string} [warning]        host-key policy warning (insecure/new key), when any
 */

/**
 * POSIX single-quote a string for `/bin/sh`.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Compose the wire command, applying `workdir` via `cd`.
 *
 * @param {string} command
 * @param {string|undefined} workdir
 * @returns {string}
 */
export function composeCommand(command, workdir) {
  const cmd = typeof command === 'string' ? command : String(command ?? '')
  if (workdir === undefined || workdir === null || workdir === '') return cmd
  return `cd ${shellQuote(String(workdir))} && ${cmd}`
}

/**
 * Bounded byte buffer that keeps the TAIL of a stream.
 */
class TailBuffer {
  /**
   * @param {number} limit max retained bytes
   */
  constructor(limit) {
    this.limit = Math.max(0, Math.floor(Number(limit) || 0))
    /** @type {Buffer[]} */
    this.chunks = []
    /** @type {number} retained bytes */
    this.length = 0
    /** @type {number} total bytes received */
    this.total = 0
    /** @type {boolean} */
    this.truncated = false
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return
    this.total += chunk.length
    if (this.limit <= 0) {
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.length += chunk.length
    let overflow = this.length - this.limit
    while (overflow > 0 && this.chunks.length > 0) {
      this.truncated = true
      const first = this.chunks[0]
      if (first.length <= overflow) {
        this.chunks.shift()
        this.length -= first.length
        overflow -= first.length
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.length -= overflow
        overflow = 0
      }
    }
  }

  /** @returns {Buffer} */
  toBuffer() {
    return Buffer.concat(this.chunks, this.length)
  }

  /** @returns {string} */
  toString() {
    return this.toBuffer().toString('utf8')
  }
}

/**
 * Execute one command on an authenticated client. Never retries: the caller
 * (transport) owns pooling/retry.
 *
 * @param {import('ssh2').Client} client
 * @param {string} command
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.pty]
 * @param {(data: ExecDataChunk) => void} [options.onData]
 *   live output observer: called with UTF-8 decoded text per data event, in
 *   arrival order. Callback errors are swallowed. It is never called after the
 *   returned promise settles, and the text is the full output (independent of
 *   the `maxBytes` result tail).
 * @returns {Promise<ExecResult>}
 */
export function runExec(client, command, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_EXEC_TIMEOUT_MS
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(0, Math.floor(Number(options.maxBytes))) : DEFAULT_MAX_OUTPUT_BYTES
  const abortSignal = options.signal
  const usePty = options.pty === true
  const dataListener = typeof options.onData === 'function' ? options.onData : null
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortError())
      return
    }

    const stdout = new TailBuffer(maxBytes)
    const stderr = new TailBuffer(maxBytes)
    // One decoder per stream keeps multi-byte UTF-8 characters intact even when
    // a code point is split across TCP/channel chunks.
    const stdoutDecoder = dataListener ? new StringDecoder('utf8') : null
    const stderrDecoder = dataListener ? new StringDecoder('utf8') : null
    /** @type {{ code: number|null, signal: string|null }|null} */
    let exitInfo = null
    /** @type {unknown} */
    let streamError = null
    let settled = false
    let timedOut = false
    /** @type {NodeJS.Timeout|null} */
    let timer = null
    /** @type {null | (() => void)} */
    let onAbort = null
    /** @type {any} */
    let stream = null

    /**
     * Deliver one decoded text chunk to the live observer. Never throws and
     * never fires after settlement, so a misbehaving observer cannot change
     * exec semantics.
     *
     * @param {ExecStream} streamName
     * @param {string} chunk
     */
    const emitData = (streamName, chunk) => {
      if (!dataListener || !chunk || settled) return
      try {
        dataListener({ stream: streamName, chunk })
      } catch {
        // An observer error must not affect the remote command/result.
      }
    }

    /** Flush both decoders' residual bytes before resolving. */
    const flushDecoders = () => {
      if (!dataListener) return
      if (stdoutDecoder) {
        const rest = stdoutDecoder.end()
        if (rest) emitData('stdout', rest)
      }
      if (stderrDecoder) {
        const rest = stderrDecoder.end()
        if (rest) emitData('stderr', rest)
      }
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (abortSignal && onAbort) {
        try {
          abortSignal.removeEventListener('abort', onAbort)
        } catch {
          // ignore
        }
        onAbort = null
      }
    }

    /** Best-effort channel teardown; the remote process is expected to die. */
    const killChannel = () => {
      if (!stream) return
      try {
        stream.signal?.('KILL')
      } catch {
        // some servers reject signal requests; close below still ends the process
      }
      try {
        stream.close?.()
      } catch {
        // ignore
      }
      try {
        stream.destroy?.()
      } catch {
        // ignore
      }
    }

    const result = () => {
      /** @type {ExecResult} */
      const value = {
        code: exitInfo && typeof exitInfo.code === 'number' ? exitInfo.code : -1,
        signal: exitInfo?.signal ?? null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
      return value
    }

    const done = () => {
      if (settled) return
      // Flush a trailing partial UTF-8 code point before settlement.
      flushDecoders()
      if (settled) return
      settled = true
      cleanup()
      resolve(result())
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    if (abortSignal) {
      onAbort = () => {
        if (settled) return
        // Claim settlement BEFORE tearing the channel down. `killChannel` can
        // emit the channel `close` synchronously; with settlement still open
        // that close would be classified as a channel failure, which makes the
        // transport dispose the pooled connection on a mere abort.
        settled = true
        cleanup()
        killChannel()
        reject(abortError())
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      flushDecoders()
      // Same ordering as the abort path: the deadline already decided the
      // outcome, so the teardown must not turn it into a failure.
      settled = true
      cleanup()
      killChannel()
      resolve(result())
    }, timeoutMs)
    timer.unref?.()

    /** @param {Error} error */
    const channelError = (error) => {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = stdout.total === 0 && stderr.total === 0 && exitInfo === null
      const err = new SshError(`Remote exec failed: ${message}`, 'CONNECT', {
        cause: error,
        channelFailure: retryable,
      })
      return err
    }

    const onStreamReady = (/** @type {any} */ channel) => {
      stream = channel
      if (settled) {
        // Aborted between the exec request and the channel callback.
        try {
          channel.destroy?.()
        } catch {
          // ignore
        }
        return
      }
      channel.on('data', (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        stdout.push(buffer)
        if (stdoutDecoder) emitData('stdout', stdoutDecoder.write(buffer))
      })
      channel.stderr?.on('data', (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        stderr.push(buffer)
        if (stderrDecoder) emitData('stderr', stderrDecoder.write(buffer))
      })
      channel.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signalName) => {
        exitInfo = {
          code: typeof code === 'number' ? code : null,
          signal: signalName ?? null,
        }
      })
      channel.on('error', (error) => {
        if (settled) return
        streamError = error
      })
      channel.on('close', () => {
        if (settled) return
        if (streamError) {
          fail(channelError(streamError instanceof Error ? streamError : new Error(String(streamError))))
          return
        }
        if (!exitInfo) {
          // The channel died without an exit status: treat as a channel-level
          // failure when nothing was produced (safe to retry on a fresh conn).
          fail(
            new SshError('Remote exec channel closed without an exit status', 'CONNECT', {
              channelFailure: stdout.total === 0 && stderr.total === 0,
            }),
          )
          return
        }
        done()
      })
    }

    try {
      if (usePty) {
        client.exec(command, { pty: { term: 'xterm-256color', cols: 120, rows: 32 } }, (error, channel) => {
          if (error || !channel) {
            if (settled) return
            fail(channelError(error instanceof Error ? error : new Error(String(error ?? 'exec failed'))))
            return
          }
          onStreamReady(channel)
        })
      } else {
        client.exec(command, (error, channel) => {
          if (error || !channel) {
            if (settled) return
            fail(channelError(error instanceof Error ? error : new Error(String(error ?? 'exec failed'))))
            return
          }
          onStreamReady(channel)
        })
      }
    } catch (error) {
      fail(channelError(error instanceof Error ? error : new Error(String(error))))
    }
  })
}
