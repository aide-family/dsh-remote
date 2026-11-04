/**
 * SSH connection establishment (including a single ProxyJump hop), host-key
 * verification wiring and connection error classification.
 *
 * Pooling/serialization lives in `transport.js`; this module only knows how to
 * turn a `RemoteHost` + resolved auth into a ready `ssh2.Client`.
 */

import ssh2 from 'ssh2'
import { expandHome, resolveAuth, targetLabel, toConnectConfig } from './auth.js'
import { abortError, mapConnectionError, SshError, throwIfAborted } from './errors.js'
import { fingerprintSha256 } from './known-hosts.js'

const { Client } = ssh2

/** @typedef {import('./auth.js').ResolvedAuth} ResolvedAuth */

/**
 * @typedef {object} ProxyHop
 * @property {{ id: string, host: string, port: number, username?: string }} host
 * @property {ResolvedAuth} auth
 * @property {string} raw                     original proxyJump entry
 */

/**
 * @typedef {object} ResolvedSessionAuth
 * @property {ResolvedAuth} auth              auth for the target host
 * @property {ProxyHop[]} hops                jump hops, outermost first (currently max 1)
 * @property {string} fingerprint             pool fingerprint over target + hops
 * @property {string|undefined} warning       pass-through warning (unused here)
 */

/**
 * Parse an OpenSSH `ProxyJump` entry: `user@host`, `user@host:port`,
 * `host:port` or `[ipv6]:port`.
 *
 * @param {string} entry
 * @returns {{ username?: string, host: string, port: number }}
 */
export function parseProxyJumpEntry(entry) {
  let rest = String(entry ?? '').trim()
  /** @type {string|undefined} */
  let username
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    username = rest.slice(0, at) || undefined
    rest = rest.slice(at + 1)
  }
  let host = rest
  let port = 22
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close > 0) {
      host = rest.slice(1, close)
      const after = rest.slice(close + 1)
      if (after.startsWith(':')) port = Number(after.slice(1))
    }
  } else {
    const colon = rest.indexOf(':')
    if (colon >= 0) {
      host = rest.slice(0, colon)
      port = Number(rest.slice(colon + 1))
    }
  }
  return { username, host, port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 22 }
}

/**
 * Resolve the target auth plus any ProxyJump hop auths, and compute the
 * connection-pool fingerprint (safe to log; no secrets).
 *
 * Only a single jump hop is supported; extra entries are ignored (documented
 * limitation) and reported through the logger.
 *
 * @param {any} host RemoteHost
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, fs?: any, logger?: any }} [authOptions]
 * @returns {Promise<ResolvedSessionAuth>}
 */
export async function resolveSessionAuth(host, authOptions = {}) {
  const auth = await resolveAuth(host, authOptions)
  /** @type {ProxyHop[]} */
  const hops = []
  const chain = Array.isArray(host?.proxyJump) ? host.proxyJump.filter((entry) => typeof entry === 'string' && entry.trim()) : []
  if (chain.length > 1) {
    authOptions.logger?.warn?.(`[dsh-remote] ProxyJump chains are not supported; using only "${chain[0]}" for ${host?.name ?? host?.id ?? 'host'}`)
  }
  if (chain.length > 0) {
    const parsed = parseProxyJumpEntry(chain[0])
    const hopHost = {
      id: `${host.id ?? host.name ?? 'host'}#jump0`,
      name: String(parsed.host),
      host: parsed.host,
      port: parsed.port,
      username: parsed.username ?? host.username,
      // Reuse the target host's credential references for the hop; the
      // contract has no per-hop auth fields.
      identityFile: host.identityFile,
      passwordEnv: host.passwordEnv,
      passphraseEnv: host.passphraseEnv,
      source: host.source,
    }
    const hopAuth = await resolveAuth(hopHost, authOptions)
    hops.push({ host: hopHost, auth: hopAuth, raw: chain[0] })
  }
  const parts = [auth.fingerprint]
  for (const hop of hops) parts.push(`jump(${hop.host.host}:${hop.host.port}){${hop.auth.fingerprint}}`)
  return { auth, hops, fingerprint: parts.join('>') }
}

/**
 * True when a pooled client still looks usable.
 *
 * @param {import('ssh2').Client|undefined|null} client
 * @returns {boolean}
 */
export function isClientUsable(client) {
  if (!client) return false
  const sock = /** @type {any} */ (client)._sock
  if (!sock) return false
  if (sock.destroyed) return false
  if (typeof sock.writable === 'boolean' && !sock.writable && typeof sock.readable === 'boolean' && !sock.readable) return false
  return true
}

/**
 * Open a single ssh2 Client (optionally over a pre-connected duplex `sock`).
 *
 * Resolves `{ client, warnings }` once authenticated; rejects with
 * {@link SshError} (AUTH/CONNECT/TIMEOUT/HOST_KEY) or the canonical AbortError.
 *
 * @param {any} host RemoteHost-like object
 * @param {ResolvedAuth} auth
 * @param {object} options
 * @param {number} [options.connectTimeoutMs]
 * @param {(host: any, rawKey: Buffer) => Promise<{ ok: boolean, warning?: string, reason?: string, fingerprint?: string, expected?: string }>} options.verifyHostKey
 * @param {AbortSignal} [options.signal]
 * @param {any} [options.logger]
 * @param {NodeJS.ReadWriteStream} [options.sock] pre-connected transport (ProxyJump)
 * @returns {Promise<{ client: InstanceType<typeof Client>, warnings: string[] }>}
 */
export function openClient(host, auth, options) {
  const connectTimeoutMs = Number(options.connectTimeoutMs) > 0 ? Number(options.connectTimeoutMs) : 20_000
  const verifyHostKey = options.verifyHostKey
  const signal = options.signal
  const logger = options.logger
  const target = targetLabel(host, auth.username)

  return new Promise((resolve, reject) => {
    const client = new Client()
    /** @type {string[]} */
    const warnings = []
    let settled = false
    /** @type {null | { reason?: string, fingerprint?: string, expected?: string, message?: string }} */
    let verifyFailure = null
    let timer = /** @type {NodeJS.Timeout|null} */ (null)
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

    const finishOk = () => {
      if (settled) return
      settled = true
      cleanup()
      if (warnings.length > 0) logger?.debug?.(`[dsh-remote] ${target}: ${warnings.join('; ')}`)
      resolve({ client, warnings })
    }

    /** @param {unknown} rawError */
    const fail = (rawError) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        client.end()
      } catch {
        // ignore
      }
      try {
        const sock = /** @type {any} */ (client)._sock
        sock?.destroy?.()
      } catch {
        // ignore
      }
      reject(normalizeFailure(rawError))
    }

    /** @param {unknown} rawError */
    const normalizeFailure = (rawError) => {
      if (/** @type {any} */ (rawError)?.name === 'AbortError') return rawError
      if (verifyFailure) {
        const reason = verifyFailure.reason ?? 'unknown'
        const header =
          reason === 'mismatch'
            ? `SSH host key for ${target} does not match the stored key (possible MITM); connection rejected`
            : reason === 'unknown'
              ? `SSH host key for ${target} is not trusted yet (knownHostsPolicy="strict"); connection rejected`
              : `SSH host key verification failed for ${target}`
        const details = verifyFailure.message ? `: ${verifyFailure.message}` : ''
        return new SshError(`${header}${details}`, 'HOST_KEY', {
          cause: rawError,
          target,
          host: host?.host,
          reason,
          fingerprint: verifyFailure.fingerprint,
          expectedFingerprint: verifyFailure.expected,
          actualFingerprint: verifyFailure.fingerprint,
        })
      }
      return mapConnectionError(rawError, { target, host: host?.host })
    }

    const hostVerifier = (rawKey, verify) => {
      let raw
      try {
        raw = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey)
      } catch (error) {
        verifyFailure = { reason: 'error', message: `unparseable host key: ${error instanceof Error ? error.message : String(error)}` }
        verify(false)
        return
      }
      const offered = fingerprintSha256(raw)
      Promise.resolve()
        .then(() => verifyHostKey(host, raw))
        .then((result) => {
          if (!result || result.ok !== true) {
            verifyFailure = {
              reason: result?.reason ?? result?.status ?? 'unknown',
              fingerprint: result?.fingerprint ?? offered,
              expected: result?.expected,
            }
            logger?.warn?.(
              `[dsh-remote] host key rejected for ${target}: ${result?.warning ?? 'not trusted'} (${verifyFailure.fingerprint})`,
            )
            verify(false)
            return
          }
          if (typeof result.warning === 'string' && result.warning) warnings.push(result.warning)
          verify(true)
        })
        .catch((error) => {
          verifyFailure = {
            reason: 'error',
            fingerprint: offered,
            message: error instanceof Error ? error.message : String(error),
          }
          verify(false)
        })
    }

    // Fixed-password keyboard-interactive only. Never send a password to an
    // OTP/MFA challenge, multiple prompts, an echoing prompt, or a second round.
    let answeredPasswordChallenge = false
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      const prompt = prompts?.[0]
      const isPassword = typeof prompt?.prompt === 'string' &&
        /^(?:password(?: for [^:\r\n]+)?|密码)\s*:?\s*$/iu.test(prompt.prompt.trim())
      if (!answeredPasswordChallenge && auth.password !== undefined && prompts?.length === 1 &&
          prompt.echo === false && isPassword) {
        answeredPasswordChallenge = true
        finish([auth.password])
      } else {
        finish([])
      }
    })

    client.once('ready', () => {
      logger?.debug?.(`[dsh-remote] connected to ${target}`)
      finishOk()
    })
    client.on('error', (error) => {
      fail(error)
    })
    client.on('close', () => {
      if (!settled) fail(new SshError(`SSH connection to ${target} closed before authentication completed`, 'CONNECT', { target }))
    })
    client.on('end', () => {
      if (!settled) fail(new SshError(`SSH connection to ${target} ended before authentication completed`, 'CONNECT', { target }))
    })

    timer = setTimeout(() => {
      fail(new SshError(`SSH connection to ${target} timed out after ${connectTimeoutMs}ms`, 'TIMEOUT', { target }))
    }, connectTimeoutMs)
    timer.unref?.()

    if (signal) {
      if (signal.aborted) {
        fail(abortError())
        return
      }
      onAbort = () => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    }

    /** @type {Record<string, any>} */
    const config = {
      ...toConnectConfig(auth),
      host: host?.host,
      port: Number(host?.port) > 0 ? Number(host.port) : 22,
      readyTimeout: connectTimeoutMs,
      tryKeyboard: auth.password !== undefined && host?.keyboardInteractiveAuthentication !== false,
      keepaliveInterval: 0,
      hostVerifier,
    }
    if (host?.passwordAuthentication === false || host?.pubkeyAuthentication === false) {
      config.authHandler = ['none',
        ...(auth.privateKey !== undefined && host?.pubkeyAuthentication !== false ? ['publickey'] : []),
        ...(auth.agent !== undefined && host?.pubkeyAuthentication !== false ? ['agent'] : []),
        ...(auth.password !== undefined && host?.passwordAuthentication !== false ? ['password'] : []),
        ...(config.tryKeyboard ? ['keyboard-interactive'] : []),
      ]
    }
    if (options.sock) config.sock = options.sock

    try {
      client.connect(config)
    } catch (error) {
      fail(error)
    }
  })
}

/**
 * Open the TCP channel to the final destination through a jump host.
 *
 * @param {InstanceType<typeof Client>} jumpClient
 * @param {string} destHost
 * @param {number} destPort
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<NodeJS.ReadWriteStream>}
 */
export function openForward(jumpClient, destHost, destPort, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000
  const signal = options.signal
  return new Promise((resolve, reject) => {
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
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    timer = setTimeout(() => {
      fail(new SshError(`ProxyJump forwarding to ${destHost}:${destPort} timed out after ${timeoutMs}ms`, 'TIMEOUT', { host: destHost }))
    }, timeoutMs)
    timer.unref?.()
    if (signal) {
      if (signal.aborted) {
        fail(abortError())
        return
      }
      onAbort = () => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      jumpClient.forwardOut('127.0.0.1', 0, destHost, destPort, (error, stream) => {
        if (settled) {
          try {
            stream?.destroy?.()
          } catch {
            // ignore
          }
          return
        }
        if (error || !stream) {
          fail(mapConnectionError(error ?? new Error('ProxyJump forwarding failed'), { host: destHost }))
          return
        }
        settled = true
        cleanup()
        resolve(stream)
      })
    } catch (error) {
      fail(mapConnectionError(error, { host: destHost }))
    }
  })
}

/**
 * @param {InstanceType<typeof Client>|undefined|null} client
 */
export function closeClientQuietly(client) {
  if (!client) return
  try {
    client.end()
  } catch {
    // ignore
  }
  try {
    const sock = /** @type {any} */ (client)._sock
    sock?.destroy?.()
  } catch {
    // ignore
  }
}

/**
 * Establish a pooled-session transport: resolves auth for the target and any
 * ProxyJump hop, connects the jump chain and returns the authenticated client
 * together with the jump clients that must stay alive with it.
 *
 * @param {any} host
 * @param {ResolvedSessionAuth} resolved
 * @param {object} options
 * @param {number} [options.connectTimeoutMs]
 * @param {(host: any, rawKey: Buffer) => Promise<any>} options.verifyHostKey
 * @param {AbortSignal} [options.signal]
 * @param {any} [options.logger]
 * @returns {Promise<{ client: InstanceType<typeof Client>, jumpClients: InstanceType<typeof Client>[], warnings: string[] }>}
 */
export async function openSession(host, resolved, options) {
  throwIfAborted(options.signal)
  const connectTimeoutMs = Number(options.connectTimeoutMs) > 0 ? Number(options.connectTimeoutMs) : 20_000
  /** @type {InstanceType<typeof Client>[]} */
  const jumpClients = []
  /** @type {string[]} */
  const warnings = []
  let sock
  try {
    if (resolved.hops.length > 0) {
      const hop = resolved.hops[0]
      const jump = await openClient(hop.host, hop.auth, {
        connectTimeoutMs,
        verifyHostKey: options.verifyHostKey,
        signal: options.signal,
        logger: options.logger,
      })
      jumpClients.push(jump.client)
      warnings.push(...jump.warnings)
      sock = await openForward(jump.client, host.host, Number(host.port) > 0 ? Number(host.port) : 22, {
        signal: options.signal,
        timeoutMs: connectTimeoutMs,
      })
    }
    const opened = await openClient(host, resolved.auth, {
      connectTimeoutMs,
      verifyHostKey: options.verifyHostKey,
      signal: options.signal,
      logger: options.logger,
      sock,
    })
    warnings.push(...opened.warnings)
    return { client: opened.client, jumpClients, warnings }
  } catch (error) {
    for (const client of jumpClients) closeClientQuietly(client)
    try {
      sock?.destroy?.()
    } catch {
      // ignore
    }
    throw error
  }
}

/**
 * Fingerprint helpers re-exported for the fixture/test integration.
 *
 * @param {Buffer} raw
 * @returns {string}
 */
export function hostKeyFingerprint(raw) {
  return fingerprintSha256(raw)
}

/**
 * Expand `~` for a host's identity file (exported convenience for tools).
 *
 * @param {string} value
 * @param {string} [home]
 */
export function expandIdentityPath(value, home) {
  return expandHome(value, home)
}
