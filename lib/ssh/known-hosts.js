/**
 * Host-key policy store (TOFU / strict / insecure) for the SSH transport.
 *
 * Fingerprints are OpenSSH-style SHA-256 fingerprints (`SHA256:<base64>`)
 * computed over the raw SSH host public key blob, persisted as JSON:
 *
 * ```json
 * {
 *   "version": 1,
 *   "hosts": {
 *     "10.0.0.11:22": {
 *       "fingerprint": "SHA256:....",
 *       "algorithm": "ssh-ed25519",
 *       "addedAt": "2026-01-01T00:00:00.000Z",
 *       "lastSeenAt": "2026-01-01T00:00:00.000Z"
 *     }
 *   }
 * }
 * ```
 *
 * The default store path is `$DSH_HOME/remote/known-hosts.json`
 * (`$DSH_HOME` defaults to `~/.dsh`). Writes are serialized and atomic
 * (temp file + rename) so concurrent connections cannot corrupt the file.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

const { utils } = ssh2

/** @typedef {"tofu"|"strict"|"insecure"} KnownHostsPolicy */

/** @type {KnownHostsPolicy[]} */
export const KNOWN_HOSTS_POLICIES = Object.freeze(['tofu', 'strict', 'insecure'])

export const KNOWN_HOSTS_STORE_VERSION = 1

/**
 * @typedef {object} KnownHostsCheck
 * @property {boolean} ok                       whether the handshake may proceed
 * @property {"unknown"|"mismatch"|"stored"|"insecure"} status
 * @property {string} fingerprint               sha256 fingerprint of the offered key
 * @property {string|undefined} algorithm       host key type (ssh-ed25519, ...)
 * @property {string|undefined} expected        stored fingerprint when it differs
 * @property {string} hostId                    "[host]:port" store key
 * @property {string|undefined} warning          user-facing warning (new key / insecure)
 */

/**
 * Resolve the default known-hosts store path from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function defaultKnownHostsPath(env = process.env, home = homedir()) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : path.join(home, '.dsh')
  return path.join(dshHome, 'remote', 'known-hosts.json')
}

/**
 * OpenSSH-style SHA-256 fingerprint of a raw SSH host public key blob.
 *
 * @param {Buffer|Uint8Array|string} rawKey
 * @returns {string} `SHA256:<base64 without padding>`
 */
export function fingerprintSha256(rawKey) {
  const buffer = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(/** @type {any} */ (rawKey))
  return `SHA256:${createHash('sha256').update(buffer).digest('base64').replace(/=+$/, '')}`
}

/**
 * Store key for a host: `host:port`, or `[host]:port` for non-22 ports.
 *
 * @param {{ host: string, port?: number }} host
 * @returns {string}
 */
export function knownHostId(host) {
  const name = String(host.host ?? '').trim()
  const port = Number(host.port) > 0 ? Number(host.port) : 22
  const bracketed = name.includes(':') && !name.startsWith('[') ? `[${name}]` : name
  return port === 22 ? bracketed : `${bracketed}:${port}`
}

/**
 * Host key type of a raw public key blob, best effort.
 *
 * @param {Buffer} rawKey
 * @returns {string|undefined}
 */
export function hostKeyAlgorithm(rawKey) {
  try {
    return utils.parseKey(rawKey)?.type
  } catch {
    return undefined
  }
}

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

/**
 * Create a host-key verification store.
 *
 * @param {object} [options]
 * @param {KnownHostsPolicy|string} [options.policy]  default "tofu"
 * @param {string} [options.filePath]                 default {@link defaultKnownHostsPath}
 * @param {object} [options.logger]
 * @param {typeof fsp} [options.fs]
 * @returns {{
 *   readonly policy: KnownHostsPolicy,
 *   readonly filePath: string,
 *   check: (host: { host: string, port?: number }, rawKey: Buffer) => Promise<KnownHostsCheck>,
 *   list: () => Promise<Record<string, { fingerprint: string, algorithm?: string, addedAt?: string, lastSeenAt?: string }>>,
 * }}
 */
export function createKnownHosts(options = {}) {
  const log = makeLogger(options.logger)
  const fs = options.fs ?? fsp
  const requested = String(options.policy ?? 'tofu').trim().toLowerCase()
  /** @type {KnownHostsPolicy} */
  const policy = /** @type {KnownHostsPolicy} */ (
    KNOWN_HOSTS_POLICIES.includes(/** @type {any} */ (requested)) ? requested : 'tofu'
  )
  if (policy !== requested) {
    log.warn(`[dsh-remote] unknown knownHostsPolicy "${options.policy}", falling back to "tofu"`)
  }
  const filePath = options.filePath ? String(options.filePath) : defaultKnownHostsPath()
  /** Serializes read-modify-write cycles for this store. */
  let queue = Promise.resolve()

  /**
   * Read the store JSON. Returns an empty store on a missing file; corrupt
   * JSON is reported and treated as empty (strict policy then fails closed
   * because no key is known).
   *
   * @returns {Promise<{ version: number, hosts: Record<string, { fingerprint: string, algorithm?: string, addedAt?: string, lastSeenAt?: string }> }>}
   */
  async function readStore() {
    let text
    try {
      text = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { version: KNOWN_HOSTS_STORE_VERSION, hosts: {} }
      log.warn(`[dsh-remote] cannot read known-hosts store ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
      return { version: KNOWN_HOSTS_STORE_VERSION, hosts: {} }
    }
    try {
      const parsed = JSON.parse(text)
      const hosts = parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {}
      return { version: Number(parsed?.version) || KNOWN_HOSTS_STORE_VERSION, hosts }
    } catch (error) {
      log.warn(`[dsh-remote] known-hosts store ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return { version: KNOWN_HOSTS_STORE_VERSION, hosts: {} }
    }
  }

  /** @param {{ version: number, hosts: Record<string, any> }} store */
  async function writeStore(store) {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const temp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const payload = `${JSON.stringify({ version: KNOWN_HOSTS_STORE_VERSION, hosts: store.hosts }, null, 2)}\n`
    await fs.writeFile(temp, payload, { mode: 0o600 })
    await fs.rename(temp, filePath)
  }

  /**
   * Verify an offered host key against the policy and, for `tofu`, persist a
   * new key. Never throws: filesystem problems degrade to a warning (and for
   * strict policy an unreadable store simply means "unknown key" → reject).
   *
   * @param {{ host: string, port?: number }} host
   * @param {Buffer} rawKey
   * @returns {Promise<KnownHostsCheck>}
   */
  async function check(host, rawKey) {
    const hostId = knownHostId(host)
    const fingerprint = fingerprintSha256(rawKey)
    const algorithm = hostKeyAlgorithm(rawKey)

    if (policy === 'insecure') {
      return {
        ok: true,
        status: 'insecure',
        fingerprint,
        algorithm,
        hostId,
        warning: `Host key verification is disabled (knownHostsPolicy="insecure") for ${hostId}; fingerprint ${fingerprint}`,
      }
    }

    const store = await readStore()
    const record = store.hosts[hostId]

    if (record && typeof record.fingerprint === 'string') {
      if (record.fingerprint === fingerprint) {
        // Refresh lastSeenAt lazily only when it is meaningfully stale (> 1 day)
        // to avoid a write on every single connection.
        try {
          const lastSeen = Date.parse(record.lastSeenAt ?? '')
          if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 86_400_000) {
            await queueWrite(async () => {
              const latest = await readStore()
              const current = latest.hosts[hostId]
              if (!current || current.fingerprint !== fingerprint) return
              latest.hosts[hostId] = { ...current, lastSeenAt: new Date().toISOString() }
              await writeStore(latest)
            })
          }
        } catch (error) {
          log.debug?.(`[dsh-remote] known-hosts lastSeen refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return { ok: true, status: 'stored', fingerprint, algorithm, hostId }
      }
      log.warn(
        `[dsh-remote] host key mismatch for ${hostId}: expected ${record.fingerprint}, received ${fingerprint}`,
      )
      return {
        ok: false,
        status: 'mismatch',
        fingerprint,
        algorithm,
        expected: record.fingerprint,
        hostId,
        warning: `Host key for ${hostId} changed (expected ${record.fingerprint}, got ${fingerprint})`,
      }
    }

    if (policy === 'strict') {
      return {
        ok: false,
        status: 'unknown',
        fingerprint,
        algorithm,
        hostId,
        warning: `Unknown host key for ${hostId} (knownHostsPolicy="strict", fingerprint ${fingerprint})`,
      }
    }

    // TOFU: persist the first key we see. A store write failure must not block
    // the session (OpenSSH warns and keeps going), but it does get reported.
    let warning
    try {
      await queueWrite(async () => {
        const latest = await readStore()
        const existing = latest.hosts[hostId]
        if (existing && typeof existing.fingerprint === 'string') return
        latest.hosts[hostId] = {
          fingerprint,
          ...(algorithm ? { algorithm } : {}),
          addedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        }
        await writeStore(latest)
      })
    } catch (error) {
      warning = `Could not persist host key for ${hostId}: ${error instanceof Error ? error.message : String(error)}`
      log.warn(`[dsh-remote] ${warning}`)
    }
    log.info?.(`[dsh-remote] trusted new host key for ${hostId} (${algorithm ?? 'unknown'} ${fingerprint})`)
    return {
      ok: true,
      status: 'unknown',
      fingerprint,
      algorithm,
      hostId,
      warning: warning ?? `Trusted new host key for ${hostId} (${algorithm ?? 'unknown'} ${fingerprint})`,
    }
  }

  /**
   * Run a store mutation through the serialization chain.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function queueWrite(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** @returns {Promise<Record<string, any>>} */
  async function list() {
    const store = await readStore()
    return store.hosts
  }

  return { policy, filePath, check, list }
}
