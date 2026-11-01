/**
 * Authentication resolution for remote hosts.
 *
 * Order (first that applies wins — see docs/ARCHITECTURE.md):
 *   1. `passwordEnv`      env var NAME whose VALUE is the password.
 *   2. `identityFile`     private key path (`~` allowed) + optional
 *                         `passphraseEnv` env var NAME for the passphrase.
 *   3. `SSH_AUTH_SOCK`    ssh-agent socket (only when the socket exists).
 *   4. default keys       `~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, `~/.ssh/id_rsa`.
 *
 * Secrets (passwords/passphrases/private key material) are only ever read from
 * environment variables or identity files. They are never logged and never
 * embedded in the fingerprint used for connection pooling — fingerprints are
 * short hashes or env-var/file names.
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { SshError } from './errors.js'

/** Default private keys tried when no explicit identity is configured. */
export const DEFAULT_KEY_NAMES = Object.freeze(['id_ed25519', 'id_ecdsa', 'id_rsa'])

/**
 * @typedef {object} ResolvedAuth
 * @property {"password"|"key"|"agent"|"default-key"|"none"} method
 * @property {string|undefined} username          login user to send
 * @property {string|undefined} password          secret (password method only)
 * @property {Buffer|undefined} privateKey        key material (key methods only)
 * @property {string|undefined} passphrase        secret (encrypted key only)
 * @property {string|undefined} passphraseEnv     env var NAME that supplied the passphrase
 * @property {string|undefined} agent             ssh-agent socket path
 * @property {string|undefined} identityFile      resolved identity file path
 * @property {string} fingerprint                 safe-to-log pool fingerprint
 * @property {string|undefined} passwordEnv       env var NAME that supplied the password
 */

/**
 * Expand a leading `~` (or `~/...`) against `home`.
 *
 * @param {string} value
 * @param {string} [home]
 * @returns {string}
 */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string' || !value) return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return `${home}${value.slice(1)}`
  return value
}

/**
 * Opaque, non-reversible fingerprint fragment for a secret. Safe to log.
 *
 * @param {string|Buffer|undefined} secret
 * @returns {string}
 */
function secretFingerprint(secret) {
  if (secret === undefined || secret === null) return 'none'
  const hash = createHash('sha256')
  hash.update(Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret)))
  return hash.digest('hex').slice(0, 16)
}

/**
 * Ensure a file is readable; throws a descriptive SshError otherwise.
 *
 * @param {string} filePath
 * @param {typeof fsp} fs
 * @returns {Promise<Buffer>}
 */
async function readIdentityFile(filePath, fs) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SshError(`Cannot read SSH identity file ${filePath}: ${message}`, 'CONNECT', {
      cause: error,
    })
  }
}

/**
 * True when `socketPath` exists and is a socket (or other filesystem node that
 * an SSH agent could listen on). Missing paths mean "no agent" and fall through
 * to the next auth method.
 *
 * @param {string} socketPath
 * @param {typeof fsp} fs
 * @returns {Promise<boolean>}
 */
async function isAgentSocket(socketPath, fs) {
  try {
    await fs.stat(socketPath)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve how to authenticate to `host`. Performs local I/O only (identity file
 * reads, agent socket stat); it never connects and never logs secrets.
 *
 * @param {{ id?: string, host?: string, port?: number, username?: string, identityFile?: string, passwordEnv?: string, passphraseEnv?: string }} host
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.homeDir]
 * @param {typeof fsp} [options.fs]
 * @param {{ debug?: Function, info?: Function, warn?: Function }} [options.logger]
 * @returns {Promise<ResolvedAuth>}
 */
export async function resolveAuth(host, options = {}) {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const fs = options.fs ?? fsp
  const log = options.logger && typeof options.logger === 'object' ? /** @type {any} */ (options.logger) : {}
  const username = typeof host?.username === 'string' && host.username.trim() ? host.username.trim() : env.USER || env.LOGNAME || undefined
  const target = targetLabel(host, username)

  // 1. password from env var NAME
  const passwordEnvName = typeof host?.passwordEnv === 'string' ? host.passwordEnv.trim() : ''
  if (passwordEnvName) {
    const password = env[passwordEnvName]
    if (typeof password === 'string' && password.length > 0) {
      log.debug?.(`[dsh-remote] auth for ${target}: password (env ${passwordEnvName})`)
      return {
        method: 'password',
        username,
        password,
        passwordEnv: passwordEnvName,
        fingerprint: `password-env:${passwordEnvName}:${secretFingerprint(password)}`,
      }
    }
    log.debug?.(`[dsh-remote] auth for ${target}: passwordEnv ${passwordEnvName} is unset/empty, falling through`)
  }

  // 2. explicit identity file
  const identityFile = typeof host?.identityFile === 'string' ? host.identityFile.trim() : ''
  if (identityFile) {
    const resolved = expandHome(identityFile, home)
    const privateKey = await readIdentityFile(resolved, fs)
    const passphraseEnvName = typeof host?.passphraseEnv === 'string' ? host.passphraseEnv.trim() : ''
    const passphrase = passphraseEnvName && typeof env[passphraseEnvName] === 'string' && env[passphraseEnvName].length > 0 ? env[passphraseEnvName] : undefined
    let statSignature = ''
    try {
      const stat = await fs.stat(resolved)
      statSignature = `:${stat.mtimeMs}:${stat.size}`
    } catch {
      // The read succeeded, stat should too; keep the fingerprint stable anyway.
    }
    log.debug?.(`[dsh-remote] auth for ${target}: publickey (identity ${resolved})`)
    return {
      method: 'key',
      username,
      privateKey,
      ...(passphrase !== undefined ? { passphrase, passphraseEnv: passphraseEnvName } : {}),
      identityFile: resolved,
      fingerprint: `key:${resolved}${statSignature}:${secretFingerprint(privateKey)}`,
    }
  }

  // 3. ssh-agent
  const agentSocket = typeof env.SSH_AUTH_SOCK === 'string' ? env.SSH_AUTH_SOCK.trim() : ''
  if (agentSocket && (await isAgentSocket(agentSocket, fs))) {
    log.debug?.(`[dsh-remote] auth for ${target}: publickey (agent ${agentSocket})`)
    return {
      method: 'agent',
      username,
      agent: agentSocket,
      fingerprint: `agent:${agentSocket}`,
    }
  }

  // 4. default keys
  for (const name of DEFAULT_KEY_NAMES) {
    const candidate = path.join(home, '.ssh', name)
    let privateKey
    try {
      privateKey = await fs.readFile(candidate)
    } catch {
      continue
    }
    let statSignature = ''
    try {
      const stat = await fs.stat(candidate)
      statSignature = `:${stat.mtimeMs}:${stat.size}`
    } catch {
      // ignore
    }
    log.debug?.(`[dsh-remote] auth for ${target}: publickey (default key ${candidate})`)
    return {
      method: 'default-key',
      username,
      privateKey,
      identityFile: candidate,
      fingerprint: `default-key:${candidate}${statSignature}:${secretFingerprint(privateKey)}`,
    }
  }

  // Nothing applies: connect anyway (the server may allow "none"); a real
  // rejection surfaces as SshError code AUTH from the connect path.
  log.debug?.(`[dsh-remote] auth for ${target}: no credentials found (trying "none")`)
  return {
    method: 'none',
    username,
    fingerprint: `none:${username ?? ''}`,
  }
}

/**
 * Build the ssh2 `connect()` auth fields for a resolved auth. Never includes
 * anything the caller did not supply to {@link resolveAuth}.
 *
 * @param {ResolvedAuth} auth
 * @returns {Record<string, any>}
 */
export function toConnectConfig(auth) {
  /** @type {Record<string, any>} */
  const config = {}
  if (auth.username) config.username = auth.username
  if (auth.password !== undefined) config.password = auth.password
  if (auth.privateKey !== undefined) {
    config.privateKey = auth.privateKey
    if (auth.passphrase !== undefined) config.passphrase = auth.passphrase
  }
  if (auth.agent !== undefined) config.agent = auth.agent
  return config
}

/**
 * "user@host:port" label for messages. Never contains secrets.
 *
 * @param {{ host?: string, port?: number, username?: string }|undefined} host
 * @param {string|undefined} [username]
 * @returns {string}
 */
export function targetLabel(host, username) {
  const user = username ?? host?.username
  const hostname = host?.host ? String(host.host) : '?'
  const port = Number(host?.port) > 0 ? Number(host.port) : 22
  return `${user ? `${user}@` : ''}${hostname}:${port}`
}
