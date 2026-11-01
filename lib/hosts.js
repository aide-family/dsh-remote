/**
 * Host discovery and resolution for dsh-remote.
 *
 * Hosts come from three sources, merged into the single `RemoteHost` currency
 * every other module uses (highest priority first):
 *   1. the managed-host registry (`registryHosts`, `source: "managed"`,
 *      ids `managed:<name>`) created in the management UI and persisted by
 *      `lib/host-registry.js` — the newest declaration wins;
 *   2. the plugin config `hosts[]` -> ids `config:<name>`; these win over the
 *      OpenSSH client config because they carry explicit auth references and
 *      are what the operator configured deliberately;
 *   3. the OpenSSH client config (`~/.ssh/config`, `config.includeSshConfig`)
 *      parsed by `lib/ssh-config.js` -> ids `ssh-config:<name>`.
 *
 * `allowHosts` is NOT applied by dropping hosts here: a tool that receives a
 * disallowed host should say "host not allowed by allowHosts" instead of
 * "unknown host", and `remote_hosts` can decide what to advertise. Every tool
 * calls `isHostAllowed(host, config)`; `isHostReadonly(host, config)` is the
 * mutating-action guard, and matching hosts also carry `readonly: true`.
 *
 * The only failures that escape are *configured* host errors ("malformed
 * configured host should throw a clear Error naming the host"). A broken or
 * missing ssh config never throws: it just contributes no hosts. Registry
 * records are validated the same way as configured hosts but never throw:
 * a malformed managed record is skipped with a warning so one bad line in
 * `hosts.json` cannot break host discovery.
 *
 * @module lib/hosts
 */

import { homedir } from "node:os";

import { loadSshConfig } from "./ssh-config.js";
import { normalizeConfig } from "./config.js";

/** Cache of compiled glob patterns (readonlyHosts/allowHosts are re-evaluated per tool call). */
const GLOB_CACHE = new Map();
const MAX_CACHED_GLOBS = 512;

/** Characters that must be escaped when building a RegExp source. */
const REGEXP_SPECIAL_CHARS = new Set("\\^$.*+?()[]{}|");

/**
 * The single host shape shared by every module (see docs/ARCHITECTURE.md
 * "Host object"). `passwordEnv`/`passphraseEnv` hold environment-variable
 * NAMES, never secrets; only configured/managed hosts can carry them.
 *
 * @typedef {object} RemoteHost
 * @property {string} id Stable id: `ssh-config:<name>`, `config:<name>` or `managed:<name>`.
 * @property {string} name Lookup name the model uses (no whitespace).
 * @property {string} host Hostname/IP to connect to.
 * @property {number} [port] 1-65535, default 22.
 * @property {string} [username] Login user.
 * @property {"ssh-config" | "config" | "managed"} source Where the host was declared.
 * @property {string} [identityFile] Private key path; `~` allowed.
 * @property {string} [passwordEnv] Environment-variable NAME for password auth (config/managed host only).
 * @property {string} [passphraseEnv] Environment-variable NAME for the key passphrase (config/managed host only).
 * @property {string} [description] Human description.
 * @property {string[]} [tags] Freeform tags.
 * @property {boolean} [readonly] True when matched by `readonlyHosts`.
 * @property {string[]} [proxyJump] ProxyJump chain, `[user@]host[:port]` entries.
 * @property {boolean} [managed] True when the host came from the managed registry.
 */

/**
 * Discover and merge the current host list.
 *
 * Never throws for ssh-config or managed-registry problems (missing/unreadable/
 * garbled files and malformed managed records contribute no hosts). Throws a
 * clear Error for a malformed *configured* host, which `normalizeConfig`
 * normally catches first at plugin load.
 *
 * @param {object} config Normalized (or raw) plugin config.
 * @param {{ homeDir?: string, logger?: { warn?: (message: string) => void }, registryHosts?: unknown }} [options]
 *   `homeDir` overrides `os.homedir()` for tests; `logger` receives non-fatal warnings;
 *   `registryHosts` are `ManagedHost` records from `lib/host-registry.js`.
 * @returns {Promise<RemoteHost[]>} Hosts sorted by name (case-insensitively).
 */
export async function loadHosts(config, options = {}) {
  const normalized = normalizeConfig(config ?? {});
  const homeDir = typeof options?.homeDir === "string" ? options.homeDir : homedir();
  const logger = options?.logger;

  // Managed hosts have the highest priority: validate each record like a
  // configured host, but a malformed record is only warned about (never fatal).
  const managed = managedRemoteHosts(options?.registryHosts, logger);
  const managedNames = new Set(managed.map((host) => host.name.toLowerCase()));

  // Configured hosts are validated by normalizeConfig; managed hosts win over
  // them on a (case-insensitive) name collision, so skip the shadowed entries.
  const configured = normalized.hosts
    .filter((entry) => !managedNames.has(entry.name.toLowerCase()))
    .map((entry) => configuredRemoteHost(entry));
  const configuredNames = new Set(configured.map((host) => host.name.toLowerCase()));

  /** @type {RemoteHost[]} */
  const discovered = [];
  if (normalized.includeSshConfig) {
    /** @type {import("./ssh-config.js").SshConfigHost[]} */
    let records = [];
    try {
      // Read the ssh config exactly once per loadHosts call.
      records = loadSshConfig(normalized.sshConfigPath, { homeDir });
    } catch (error) {
      // loadSshConfig is documented never to throw; stay defensive anyway.
      records = [];
      logger?.warn?.(
        `dsh-remote: unable to read ssh config ${JSON.stringify(normalized.sshConfigPath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const record of Array.isArray(records) ? records : []) {
      if (record === null || typeof record !== "object") continue;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (name.length === 0) continue;
      const key = name.toLowerCase();
      if (managedNames.has(key) || configuredNames.has(key)) continue; // higher priority wins
      const host = sshConfigRemoteHost(record);
      if (host !== undefined) discovered.push(host);
    }
  }

  /** @type {RemoteHost[]} */
  const merged = [];
  for (const host of [...managed, ...configured, ...discovered]) {
    if (typeof host.host !== "string" || host.host.trim().length === 0) continue; // hostname-less
    merged.push(isHostReadonly(host, normalized) ? { ...host, readonly: true } : host);
  }

  return sortByName(dedupeByIdentity(merged));
}

/**
 * Build `RemoteHost`s from managed-registry records. Every record is validated
 * through `normalizeConfig` (the same rules as a configured host); invalid
 * records are skipped with a warning. `registryHosts` that is not an array is
 * treated as empty.
 *
 * @param {unknown} registryHosts
 * @param {{ warn?: (message: string) => void } | undefined} logger
 * @returns {RemoteHost[]}
 */
function managedRemoteHosts(registryHosts, logger) {
  if (!Array.isArray(registryHosts) || registryHosts.length === 0) return [];
  /** @type {RemoteHost[]} */
  const hosts = [];
  const seen = new Set();
  for (let index = 0; index < registryHosts.length; index += 1) {
    const record = registryHosts[index];
    let entry;
    try {
      // normalizeConfig gives the exact same validation/protocol rules as a
      // `config.hosts` entry and drops unknown registry-only fields.
      entry = normalizeConfig({ hosts: [record] }).hosts[0];
    } catch (error) {
      logger?.warn?.(
        `dsh-remote: ignoring managed host at registry[${index}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (entry === undefined) continue;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push(managedRemoteHost(entry));
  }
  return hosts;
}

/**
 * Resolve a host by lookup name or stable id. Exact matches win; a
 * case-insensitive fallback keeps the model's `PROD-WEB` usable against
 * `prod-web-1` without surprising exact-name ambiguity. Change hosts are
 * disambiguated by the `config:`/`ssh-config:` id prefix.
 *
 * @param {RemoteHost[]} hosts
 * @param {string} nameOrId
 * @returns {RemoteHost | undefined}
 */
export function findHost(hosts, nameOrId) {
  if (!Array.isArray(hosts) || hosts.length === 0) return undefined;
  const query = nameOrId === undefined || nameOrId === null ? "" : String(nameOrId).trim();
  if (query.length === 0) return undefined;

  let match = hosts.find((host) => host.id === query);
  if (match !== undefined) return match;
  match = hosts.find((host) => host.name === query);
  if (match !== undefined) return match;

  const lower = query.toLowerCase();
  match = hosts.find((host) => typeof host.name === "string" && host.name.toLowerCase() === lower);
  if (match !== undefined) return match;
  return hosts.find((host) => typeof host.id === "string" && host.id.toLowerCase() === lower);
}

/**
 * Is `host` usable under `config.allowHosts`? An empty/missing list allows all
 * hosts. Globs match the host *name* case-insensitively with `*` and `?`.
 *
 * @param {RemoteHost} host
 * @param {{ allowHosts?: unknown }} [config]
 * @returns {boolean}
 */
export function isHostAllowed(host, config) {
  const globs = config?.allowHosts;
  if (!Array.isArray(globs) || globs.length === 0) return true;
  if (host === null || typeof host !== "object") return false;
  if (typeof host.name !== "string" || host.name.length === 0) return false;
  return matchesAnyGlob(globs, host.name);
}

/**
 * Is `host` force-readonly? True when the host was flagged by `loadHosts` or
 * when its name matches `config.readonlyHosts`. Empty/missing list = false.
 *
 * @param {RemoteHost} host
 * @param {{ readonlyHosts?: unknown }} [config]
 * @returns {boolean}
 */
export function isHostReadonly(host, config) {
  if (host === null || typeof host !== "object") return false;
  if (host.readonly === true) return true;
  return matchesAnyGlob(config?.readonlyHosts, host.name);
}

/**
 * Build the `RemoteHost` for one entry of `config.hosts` (already normalized).
 *
 * @param {import("./config.js").ConfiguredHost} entry
 * @returns {RemoteHost}
 */
function configuredRemoteHost(entry) {
  return hostFromConfigured(entry, { source: "config", idPrefix: "config" });
}

/**
 * Build the `RemoteHost` for one managed-registry record (already validated and
 * normalized through `normalizeConfig`).
 *
 * @param {import("./config.js").ConfiguredHost} entry
 * @returns {RemoteHost}
 */
function managedRemoteHost(entry) {
  return { ...hostFromConfigured(entry, { source: "managed", idPrefix: "managed" }), managed: true };
}

/**
 * Map a validated configured-style host entry to the shared `RemoteHost` shape.
 *
 * @param {import("./config.js").ConfiguredHost} entry
 * @param {{ source: "config" | "managed", idPrefix: string }} origin
 * @returns {RemoteHost}
 */
function hostFromConfigured(entry, origin) {
  return compact({
    id: `${origin.idPrefix}:${entry.name}`,
    name: entry.name,
    host: entry.host,
    port: entry.port ?? 22,
    username: entry.username,
    identityFile: entry.identityFile,
    passwordEnv: entry.passwordEnv,
    passphraseEnv: entry.passphraseEnv,
    proxyJump: entry.proxyJump !== undefined && entry.proxyJump.length > 0 ? [...entry.proxyJump] : undefined,
    tags: entry.tags !== undefined && entry.tags.length > 0 ? [...entry.tags] : undefined,
    description: entry.description,
    source: origin.source,
  });
}

/**
 * Build the `RemoteHost` for one ssh-config record.
 *
 * @param {import("./ssh-config.js").SshConfigHost} record
 * @returns {RemoteHost | undefined}
 */
function sshConfigRemoteHost(record) {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0) return undefined;
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (host.length === 0) return undefined;

  const port =
    typeof record.port === "number" &&
    Number.isSafeInteger(record.port) &&
    record.port >= 1 &&
    record.port <= 65_535
      ? record.port
      : 22;

  return compact({
    id: `ssh-config:${name}`,
    name,
    host,
    port,
    username: typeof record.username === "string" && record.username.trim().length > 0
      ? record.username.trim()
      : undefined,
    identityFile: typeof record.identityFile === "string" && record.identityFile.trim().length > 0
      ? record.identityFile.trim()
      : undefined,
    proxyJump:
      Array.isArray(record.proxyJump) && record.proxyJump.length > 0
        ? record.proxyJump.map((hop) => String(hop))
        : undefined,
    source: "ssh-config",
  });
}

/**
 * Remove duplicate hosts by lookup name (case-insensitive) and by id. The merge
 * above already guarantees one host per name; this is the defensive last step.
 *
 * @param {RemoteHost[]} hosts
 * @returns {RemoteHost[]}
 */
function dedupeByIdentity(hosts) {
  const names = new Set();
  const ids = new Set();
  /** @type {RemoteHost[]} */
  const result = [];
  for (const host of hosts) {
    const name = typeof host.name === "string" ? host.name.toLowerCase() : "";
    if (name.length === 0 || ids.has(host.id) || names.has(name)) continue;
    names.add(name);
    ids.add(host.id);
    result.push(host);
  }
  return result;
}

/**
 * @param {RemoteHost[]} hosts
 * @returns {RemoteHost[]}
 */
function sortByName(hosts) {
  return hosts.sort((left, right) => {
    const a = String(left.name).toLowerCase();
    const b = String(right.name).toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    const leftName = String(left.name);
    const rightName = String(right.name);
    if (leftName < rightName) return -1;
    if (leftName > rightName) return 1;
    return 0;
  });
}

/**
 * @param {unknown} globs
 * @param {string} value
 * @returns {boolean}
 */
function matchesAnyGlob(globs, value) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const text = typeof value === "string" ? value : "";
  for (const pattern of globs) {
    if (typeof pattern !== "string") continue;
    const trimmed = pattern.trim();
    if (trimmed.length === 0) continue;
    if (globToRegExp(trimmed).test(text)) return true;
  }
  return false;
}

/**
 * Compile a simple case-insensitive glob (`*` = any run, `?` = one character,
 * everything else literal) to a full-match RegExp. Patterns are cached because
 * every tool call re-evaluates the readonly/allow policy.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const cached = GLOB_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += REGEXP_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
  }
  const compiled = new RegExp(`${source}$`, "iu");
  if (GLOB_CACHE.size >= MAX_CACHED_GLOBS) GLOB_CACHE.clear();
  GLOB_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} value
 * @returns {T}
 */
function compact(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
