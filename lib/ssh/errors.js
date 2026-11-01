/**
 * Error types shared by the SSH transport stack.
 *
 * Contract (see docs/ARCHITECTURE.md):
 * - `SshError.code`: `"AUTH"` | `"CONNECT"` | `"TIMEOUT"` | `"HOST_KEY"`
 * - `RemoteFsError.code`: `"ENOENT"` | `"EACCES"` | `"ENOTDIR"` | `"EISDIR"` |
 *   `"SFTP_ERROR"` | `"CONNECTION"`
 *
 * Both classes carry the original error as `cause`. Messages include the SFTP
 * status code when the server returned one (e.g. `sftp code=2`).
 */

/**
 * @typedef {"AUTH"|"CONNECT"|"TIMEOUT"|"HOST_KEY"} SshErrorCode
 * @typedef {"ENOENT"|"EACCES"|"ENOTDIR"|"EISDIR"|"SFTP_ERROR"|"CONNECTION"} RemoteFsErrorCode
 */

/** Connection-level failure (never a remote command result). */
export class SshError extends Error {
  /**
   * @param {string} message
   * @param {SshErrorCode} code
   * @param {{ cause?: unknown, host?: string, target?: string, fingerprint?: string, expectedFingerprint?: string, actualFingerprint?: string, channelFailure?: boolean, reason?: string }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SshError'
    this.code = code
    /** @type {string|undefined} human "user@host:port" target, never a secret */
    this.target = options.target
    /** @type {string|undefined} */
    this.host = options.host
    /** @type {string|undefined} sha256 fingerprint (safe to log) */
    this.fingerprint = options.fingerprint
    /** @type {string|undefined} */
    this.expectedFingerprint = options.expectedFingerprint
    /** @type {string|undefined} */
    this.actualFingerprint = options.actualFingerprint
    /** @type {string|undefined} known-hosts rejection reason: unknown | mismatch */
    this.reason = options.reason
    /** True when the failure happened at the SSH channel layer and a retry is safe. */
    this.channelFailure = options.channelFailure === true
  }
}

/** Remote filesystem failure (path- or channel-level). */
export class RemoteFsError extends Error {
  /**
   * @param {string} message
   * @param {RemoteFsErrorCode} code
   * @param {{ cause?: unknown, path?: string, sftpCode?: number|null, action?: string, channelFailure?: boolean }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RemoteFsError'
    this.code = code
    /** @type {string|undefined} remote path involved */
    this.path = options.path
    /** @type {number|null} raw SFTP status code (SSH_FX_*) when the server sent one */
    this.sftpCode = options.sftpCode ?? null
    /** @type {string|undefined} operation name (read/stat/...) for diagnostics */
    this.action = options.action
    /** True when the SFTP channel/session died (connection-level, retryable). */
    this.channelFailure = options.channelFailure === true || (code === 'CONNECTION' && options.channelFailure !== false)
  }
}

/** SFTP status code names, for messages and tests. */
export const SFTP_STATUS = Object.freeze({
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
})

/**
 * Build the canonical AbortError (name === "AbortError") used by every
 * abortable transport operation.
 *
 * @param {string} [message]
 * @returns {Error & { name: "AbortError", code: "ABORT_ERR" }}
 */
export function abortError(message = 'The operation was aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return /** @type {Error & { name: "AbortError", code: "ABORT_ERR" }} */ (error)
}

/**
 * Throw the canonical AbortError when `signal` is already aborted.
 *
 * @param {AbortSignal|undefined|null} signal
 */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError()
}

/**
 * A "channel-level" failure is safe to retry once on a fresh connection:
 * the command/channel never started (or the whole SSH session died), so
 * retrying cannot duplicate a remote side effect.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChannelFailure(error) {
  if (!error || typeof error !== 'object') return false
  // Our mappers set this explicitly; respect "false" so an error that mentions
  // e.g. "connection lost" after partial output is NOT retried (a retry could
  // duplicate a remote side effect).
  if (/** @type {any} */ (error).channelFailure === true) return true
  if (/** @type {any} */ (error).channelFailure === false) return false
  if (error instanceof RemoteFsError) return error.code === 'CONNECTION'
  const message = String(/** @type {any} */ (error).message ?? error).toLowerCase()
  if (/permission denied/.test(message)) return false
  return /channel open failure|channel closed|channel not open|connection lost|not connected|no connection|socket hang up|econnreset|epipe|ssh connection|client is not connected/.test(
    message,
  )
}

/**
 * Map a raw ssh2 SFTP error into a {@link RemoteFsError}. Path-level errors
 * (`ENOENT`, `EACCES`, ...) are NOT retryable; connection-level ones are.
 *
 * @param {unknown} error
 * @param {string} [path]
 * @param {string} [action]
 * @returns {RemoteFsError}
 */
export function mapSftpError(error, path, action = 'operation') {
  if (error instanceof RemoteFsError) return error
  const rawMessage =
    error instanceof Error ? error.message : error === undefined || error === null ? '' : String(error)
  const numericCode = typeof (/** @type {any} */ (error)?.code) === 'number' ? /** @type {any} */ (error).code : null
  const lc = rawMessage.toLowerCase()

  /** @type {RemoteFsErrorCode} */
  let code = 'SFTP_ERROR'
  if (numericCode === 2 || /no such file|does not exist|not found/.test(lc)) code = 'ENOENT'
  else if (numericCode === 3 || /permission denied|access denied/.test(lc)) code = 'EACCES'
  else if (numericCode === 6 || numericCode === 7 || /connection lost|not connected|no connection/.test(lc)) code = 'CONNECTION'
  else if (/not a directory|enotdir/.test(lc)) code = 'ENOTDIR'
  else if (/is a directory|eisdir/.test(lc)) code = 'EISDIR'

  const details = [rawMessage || 'SFTP failure']
  if (path) details.push(`path=${JSON.stringify(path)}`)
  if (numericCode !== null) details.push(`sftp code=${numericCode}`)
  // Keep the action first so callers reading a message get context.
  const message = `${action} failed: ${details.join(' · ')}`
  return new RemoteFsError(message, code, {
    cause: error === undefined ? undefined : error,
    path,
    sftpCode: numericCode,
    action,
    channelFailure: code === 'CONNECTION',
  })
}

/**
 * Map a raw ssh2 client error into a {@link SshError}.
 *
 * @param {unknown} error
 * @param {{ target?: string, host?: string, cause?: unknown }} [info]
 * @returns {SshError}
 */
export function mapConnectionError(error, info = {}) {
  if (error instanceof SshError) return error
  const err = /** @type {any} */ (error)
  const message = err instanceof Error ? err.message : String(error ?? '')
  const level = err?.level
  const rawCode = err?.code
  const lc = message.toLowerCase()
  const target = info.target
  const targetLabel = target ? ` (${target})` : ''

  /** @type {SshErrorCode} */
  let code = 'CONNECT'
  if (level === 'client-authentication' || /all configured authentication methods failed|authentication failed|unable to authenticate/.test(lc)) {
    code = 'AUTH'
  } else if (/bad passphrase|integrity check failed|error decrypting private key|decrypt.*private key/.test(lc)) {
    // A wrong key passphrase is a credential problem, not a network one.
    code = 'AUTH'
  } else if (level === 'client-timeout' || rawCode === 'ETIMEDOUT' || /timed out|timeout/.test(lc)) {
    code = 'TIMEOUT'
  } else if (/host denied|host key|verification failed|hostnotallowed/.test(lc)) {
    code = 'HOST_KEY'
  }

  const prefix =
    code === 'AUTH'
      ? 'SSH authentication failed'
      : code === 'TIMEOUT'
        ? 'SSH connection timed out'
        : code === 'HOST_KEY'
          ? 'SSH host key rejected'
          : 'SSH connection failed'
  const detail = message && !message.startsWith(prefix) ? `${prefix}${targetLabel}: ${message}` : `${prefix}${targetLabel}`
  return new SshError(detail, code, {
    cause: info.cause ?? error,
    target: info.target,
    host: info.host,
  })
}
