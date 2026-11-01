/**
 * Persisted managed-host registry for dsh-remote (v0.5).
 *
 * User-created hosts live in `$DSH_HOME/remote/hosts.json` and are merged into
 * the host list by `lib/hosts.js` (`source: "managed"`). This module is the
 * only writer of that file: it validates input (never storing a secret value —
 * auth is referenced by environment-variable NAME), keeps an in-memory list,
 * and persists atomically (temp file in the same directory + rename, mode
 * 0600). A missing file is an empty registry; a corrupt file warns and yields
 * no hosts, never an exception.
 *
 * `load()` is idempotent: the file is read once, mutations update both the
 * in-memory list and the file. All mutations are serialized so concurrent API
 * calls cannot lose an update.
 *
 * @module lib/host-registry
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** On-disk schema version (`{ version: 1, hosts: [] }`). */
const REGISTRY_VERSION = 1;

/** Managed host lookup-name rules (see docs/ARCHITECTURE.md, Managed host registry). */
const HOST_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/u;

/** Login-user rules (the registry mirrors the OpenSSH-friendly character set). */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/u;

/** Environment-variable NAME references (passwordEnv/passphraseEnv, never values). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** `[user@]host[:port]` proxy-jump hop. IPv6 literals are accepted in brackets. */
const PROXY_JUMP_RE = /^(?:[^@\s]+@)?(?:\[[^\]\s]+\]|[^:@\s]+)(?::\d{1,5})?$/u;

/** Raw secret field names that must never be persisted. */
const SECRET_FIELD_NAMES = new Set(["password", "passphrase", "secret", "token"]);

const MAX_HOST_LENGTH = 255;
const MAX_IDENTITY_FILE_LENGTH = 1024;
const MAX_PROXY_JUMP_HOPS = 8;
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 32;
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * A persisted managed host. Auth fields are environment-variable NAMES/city
 * key paths, never secret values.
 *
 * @typedef {object} ManagedHost
 * @property {string} name Unique lookup name (case-insensitive), `/^[A-Za-z0-9._-]{1,64}$/`.
 * @property {string} host Hostname or IP address (no whitespace, <=255 chars).
 * @property {number} port SSH port, 1-65535 (default 22).
 * @property {string} [username] Login user.
 * @property {string} [identityFile] Private key path; `~` is allowed.
 * @property {string} [passwordEnv] Environment-variable NAME holding the password.
 * @property {string} [passphraseEnv] Environment-variable NAME holding the key passphrase.
 * @property {string[]} [proxyJump] `[user@]host[:port]` jumps.
 * @property {string[]} [tags] Freeform tags (<=16 entries, each <=32 chars).
 * @property {string} [description] Human description (<=200 chars).
 * @property {true} managed Always true for registry records.
 * @property {number} createdAt Creation timestamp (ms since epoch).
 * @property {number} updatedAt Last-mutation timestamp (ms since epoch).
 */

/**
 * Create the persisted host registry.
 *
 * @param {object} options
 * @param {string} options.filePath Registry JSON path; `~` is expanded.
 * @param {{ warn?: (message: string) => void }} [options.logger] Non-fatal warning sink.
 * @returns {{
 *   load: () => Promise<ManagedHost[]>,
 *   list: () => ManagedHost[],
 *   get: (name: string) => ManagedHost | undefined,
 *   create: (input: object) => Promise<ManagedHost>,
 *   update: (name: string, input: object) => Promise<ManagedHost>,
 *   delete: (name: string) => Promise<boolean>,
 *   filePath: string,
 * }}
 */
export function createHostRegistry({ filePath, logger } = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TypeError("dsh-remote: createHostRegistry requires a non-empty filePath");
  }
  const resolvedPath = expandHome(filePath.trim());

  /** @type {ManagedHost[]} in-memory list (unsorted; `list()` sorts copies). */
  let hosts = [];
  let loaded = false;
  /** @type {Promise<void> | undefined} */
  let loadPromise;
  /** @type {Promise<unknown>} mutation serialization queue */
  let queue = Promise.resolve();

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // logging must never break the registry
    }
  };

  /** Read and validate the file; never throws. */
  async function readFromDisk() {
    let text;
    try {
      text = await readFile(resolvedPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      warn(`dsh-remote: host registry: unable to read ${resolvedPath}: ${messageOf(error)}`);
      return [];
    }
    if (text.trim().length === 0) return [];

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      warn(`dsh-remote: host registry: corrupt file ${resolvedPath} (${messageOf(error)}); ignoring it`);
      return [];
    }
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.hosts)) {
      warn(`dsh-remote: host registry: unexpected file format in ${resolvedPath}; expected { version: 1, hosts: [] }`);
      return [];
    }

    /** @type {ManagedHost[]} */
    const records = [];
    const seen = new Set();
    for (let index = 0; index < payload.hosts.length; index += 1) {
      let record;
      try {
        record = normalizeStoredRecord(payload.hosts[index]);
      } catch (error) {
        warn(`dsh-remote: host registry: ignoring invalid entry hosts[${index}]: ${messageOf(error)}`);
        continue;
      }
      const key = record.name.toLowerCase();
      if (seen.has(key)) {
        warn(`dsh-remote: host registry: ignoring duplicate managed host ${JSON.stringify(record.name)}`);
        continue;
      }
      seen.add(key);
      records.push(record);
    }
    return records;
  }

  /**
   * Read the registry once (idempotent). Best effort: a broken file yields an
   * empty list; it never throws.
   *
   * @returns {Promise<ManagedHost[]>}
   */
  async function load() {
    if (loaded) return list();
    if (loadPromise === undefined) {
      loadPromise = readFromDisk()
        .then((records) => {
          hosts = records;
          loaded = true;
        })
        .catch((error) => {
          // readFromDisk already contains its errors; stay defensive.
          hosts = [];
          loaded = true;
          warn(`dsh-remote: host registry: load failed: ${messageOf(error)}`);
        })
        .finally(() => {
          loadPromise = undefined;
        });
    }
    await loadPromise;
    return list();
  }

  /**
   * The cached host list, sorted by name (case-insensitive). Returns defensive
   * copies so callers cannot mutate the registry state.
   *
   * @returns {ManagedHost[]}
   */
  function list() {
    return sortByName(hosts).map((record) => ({ ...record, ...(record.proxyJump ? { proxyJump: [...record.proxyJump] } : {}), ...(record.tags ? { tags: [...record.tags] } : {}) }));
  }

  /**
   * Look a managed host up by name (case-insensitive).
   *
   * @param {string} name
   * @returns {ManagedHost | undefined}
   */
  function get(name) {
    if (typeof name !== "string") return undefined;
    const key = name.trim().toLowerCase();
    if (key.length === 0) return undefined;
    const record = hosts.find((candidate) => candidate.name.toLowerCase() === key);
    return record === undefined ? undefined : cloneRecord(record);
  }

  /**
   * Serialize one mutation behind the current queue; previous failures do not
   * poison the next mutation.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function mutate(task) {
    const run = queue.then(() => task());
    queue = run.then(noop, noop);
    return run;
  }

  /**
   * Write the whole registry atomically: temp file in the same directory with
   * mode 0600, then rename over the target.
   *
   * @param {ManagedHost[]} records
   * @returns {Promise<void>}
   */
  async function persist(records) {
    const directory = dirname(resolvedPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = join(directory, `.${basenameOf(resolvedPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const payload = `${JSON.stringify({ version: REGISTRY_VERSION, hosts: sortByName(records) }, null, 2)}\n`;
    try {
      await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, resolvedPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Create a host. Existing name (case-insensitive) -> HOST_EXISTS.
   *
   * @param {object} input ManagedHostInput.
   * @returns {Promise<ManagedHost>}
   */
  function create(input) {
    return mutate(async () => {
      await load();
      const fields = normalizeManagedInput(input, undefined);
      ensureUnique(fields.name, undefined);
      const now = Date.now();
      const record = { ...fields, managed: /** @type {true} */ (true), createdAt: now, updatedAt: now };
      const previous = hosts;
      hosts = [...hosts, record];
      try {
        await persist(hosts);
      } catch (error) {
        hosts = previous;
        throw error;
      }
      return cloneRecord(record);
    });
  }

  /**
   * Replace a host's editable fields. Missing name -> HOST_NOT_FOUND; a rename
   * onto another existing name -> HOST_EXISTS.
   *
   * @param {string} name Current lookup name.
   * @param {object} input ManagedHostInput (name may be omitted to keep the current name).
   * @returns {Promise<ManagedHost>}
   */
  function update(name, input) {
    return mutate(async () => {
      await load();
      const index = indexOfName(name);
      if (index < 0) throw hostNotFound(name);
      const existing = hosts[index];
      const fields = normalizeManagedInput(input, existing.name);
      ensureUnique(fields.name, index);
      const now = Math.max(Date.now(), existing.createdAt);
      const record = {
        ...fields,
        managed: /** @type {true} */ (true),
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      const previous = hosts;
      hosts = hosts.map((candidate, candidateIndex) => (candidateIndex === index ? record : candidate));
      try {
        await persist(hosts);
      } catch (error) {
        hosts = previous;
        throw error;
      }
      return cloneRecord(record);
    });
  }

  /**
   * Delete a host. Missing name -> HOST_NOT_FOUND.
   *
   * @param {string} name Lookup name (case-insensitive).
   * @returns {Promise<boolean>} True when removed.
   */
  function remove(name) {
    return mutate(async () => {
      await load();
      const index = indexOfName(name);
      if (index < 0) throw hostNotFound(name);
      const previous = hosts;
      hosts = hosts.filter((_candidate, candidateIndex) => candidateIndex !== index);
      try {
        await persist(hosts);
      } catch (error) {
        hosts = previous;
        throw error;
      }
      return true;
    });
  }

  /** @param {unknown} name @returns {number} Index in `hosts`, or -1. */
  function indexOfName(name) {
    if (typeof name !== "string") return -1;
    const key = name.trim().toLowerCase();
    if (key.length === 0) return -1;
    return hosts.findIndex((record) => record.name.toLowerCase() === key);
  }

  /**
   * @param {string} hostName
   * @param {number | undefined} skipIndex Index allowed to keep the name (update).
   */
  function ensureUnique(hostName, skipIndex) {
    const key = hostName.toLowerCase();
    const clash = hosts.some(
      (record, index) => index !== skipIndex && record.name.toLowerCase() === key,
    );
    if (clash) {
      throw registryError("HOST_EXISTS", `managed host ${JSON.stringify(hostName)} already exists`);
    }
  }

  return { load, list, get, create, update, delete: remove, filePath: resolvedPath };
}

/**
 * Validate one create/update input and return the normalized editable fields
 * (no timestamps/managed flag; `port` always present). Throws errors with
 * `code: "HOST_INVALID"`.
 *
 * @param {unknown} input
 * @param {string | undefined} fallbackName Used by `update` when `input.name` is omitted.
 * @returns {Omit<ManagedHost, "managed" | "createdAt" | "updatedAt">}
 */
function normalizeManagedInput(input, fallbackName) {
  const source = asRecord(input);
  rejectSecretFields(source);

  const nameValue = source.name === undefined || source.name === null ? fallbackName : source.name;
  const name = hostNameField(nameValue);
  const host = hostField(source.host);

  const normalized = {
    name,
    host,
    port: portField(source.port),
    username: usernameField(source.username),
    identityFile: identityFileField(source.identityFile),
    passwordEnv: envNameField(source.passwordEnv, "passwordEnv"),
    passphraseEnv: envNameField(source.passphraseEnv, "passphraseEnv"),
    proxyJump: proxyJumpField(source.proxyJump),
    tags: tagsField(source.tags),
    description: descriptionField(source.description),
  };
  return compact(normalized);
}

/**
 * Tolerant variant used for records already on disk: only known fields are
 * read (so a hand-edited `password` key is ignored, never surfaced).
 *
 * @param {unknown} raw
 * @returns {ManagedHost}
 */
function normalizeStoredRecord(raw) {
  const source = asRecord(raw);
  const fields = normalizeManagedInput(
    {
      name: source.name,
      host: source.host,
      port: source.port,
      username: source.username,
      identityFile: source.identityFile,
      passwordEnv: source.passwordEnv,
      passphraseEnv: source.passphraseEnv,
      proxyJump: source.proxyJump,
      tags: source.tags,
      description: source.description,
    },
    undefined,
  );
  const createdAt = timestampField(source.createdAt) ?? Date.now();
  const updatedAt = timestampField(source.updatedAt) ?? createdAt;
  return { ...fields, managed: /** @type {true} */ (true), createdAt, updatedAt };
}

/** @param {unknown} input @returns {Record<string, unknown>} */
function asRecord(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid(`host must be an object (got ${formatValue(input)})`);
  }
  return /** @type {Record<string, unknown>} */ (input);
}

/**
 * The registry stores auth *references* only: reject raw secret fields so a
 * pasted password can never reach the file. Unknown non-secret fields are
 * ignored (the browser may echo HostView-only fields such as `managed`).
 *
 * @param {Record<string, unknown>} source
 */
function rejectSecretFields(source) {
  for (const key of Object.keys(source)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      throw invalid(
        `raw secret field ${JSON.stringify(key)} is not accepted; use passwordEnv/passphraseEnv ` +
          "environment-variable NAMES instead",
      );
    }
  }
}

/** @param {unknown} value @returns {string} */
function hostNameField(value) {
  if (typeof value !== "string" || !HOST_NAME_RE.test(value.trim())) {
    throw invalid(`name must match ${HOST_NAME_RE.source} (got ${formatValue(value)})`);
  }
  return value.trim();
}

/** @param {unknown} value @returns {string} */
function hostField(value) {
  if (typeof value !== "string") {
    throw invalid(`host must be a non-empty string (got ${formatValue(value)})`);
  }
  const host = value.trim();
  if (host.length === 0) throw invalid("host must not be empty");
  if (host.length > MAX_HOST_LENGTH) {
    throw invalid(`host must be at most ${MAX_HOST_LENGTH} characters`);
  }
  if (/\s/u.test(host)) throw invalid(`host ${JSON.stringify(host)} must not contain whitespace`);
  return host;
}

/** @param {unknown} value @returns {number} */
function portField(value) {
  if (value === undefined || value === null || value === "") return 22;
  const numeric =
    typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    numeric < 1 ||
    numeric > 65_535
  ) {
    throw invalid(`port must be an integer between 1 and 65535 (got ${formatValue(value)})`);
  }
  return numeric;
}

/** @param {unknown} value @returns {string | undefined} */
function usernameField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalid(`username must be a string (got ${formatValue(value)})`);
  }
  const username = value.trim();
  if (username.length === 0) return undefined;
  if (!USERNAME_RE.test(username)) {
    throw invalid(`username must match ${USERNAME_RE.source} (got ${JSON.stringify(username)})`);
  }
  return username;
}

/** @param {unknown} value @returns {string | undefined} */
function identityFileField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalid(`identityFile must be a path string (got ${formatValue(value)})`);
  }
  const identityFile = value.trim();
  if (identityFile.length === 0) return undefined;
  if (identityFile.length > MAX_IDENTITY_FILE_LENGTH) {
    throw invalid(`identityFile must be at most ${MAX_IDENTITY_FILE_LENGTH} characters`);
  }
  if (/[\0\r\n]/u.test(identityFile)) {
    throw invalid("identityFile must not contain control characters or newlines");
  }
  return identityFile;
}

/**
 * @param {unknown} value
 * @param {"passwordEnv" | "passphraseEnv"} key
 * @returns {string | undefined}
 */
function envNameField(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalid(`${key} must be an environment-variable NAME (got ${formatValue(value)})`);
  }
  const name = value.trim();
  if (name.length === 0) return undefined;
  if (!ENV_NAME_RE.test(name)) {
    throw invalid(
      `${key} must be the NAME of an environment variable matching ${ENV_NAME_RE.source} ` +
        `— never the secret value itself (got ${JSON.stringify(name)})`,
    );
  }
  return name;
}

/** @param {unknown} value @returns {string[] | undefined} */
function proxyJumpField(value) {
  if (value === undefined || value === null) return undefined;
  const entries = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(entries)) {
    throw invalid(`proxyJump must be a string or an array of "[user@]host[:port]" strings (got ${formatValue(value)})`);
  }
  const hops = [];
  for (const entry of entries) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "string") {
      throw invalid(`proxyJump entries must be strings (got ${formatValue(entry)})`);
    }
    const hop = entry.trim();
    if (hop.length === 0) continue;
    if (!PROXY_JUMP_RE.test(hop)) {
      throw invalid(`proxyJump entry ${JSON.stringify(hop)} must look like "[user@]host[:port]"`);
    }
    hops.push(hop);
  }
  if (hops.length === 0) return undefined;
  if (hops.length > MAX_PROXY_JUMP_HOPS) {
    throw invalid(`proxyJump accepts at most ${MAX_PROXY_JUMP_HOPS} hops`);
  }
  return hops;
}

/** @param {unknown} value @returns {string[] | undefined} */
function tagsField(value) {
  if (value === undefined || value === null) return undefined;
  const entries = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(entries)) {
    throw invalid(`tags must be a string or an array of strings (got ${formatValue(value)})`);
  }
  /** @type {string[]} */
  const tags = [];
  for (const entry of entries) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "string") {
      throw invalid(`tags entries must be strings (got ${formatValue(entry)})`);
    }
    const tag = entry.trim();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw invalid(`tag ${JSON.stringify(tag)} is longer than ${MAX_TAG_LENGTH} characters`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) return undefined;
  if (tags.length > MAX_TAGS) throw invalid(`tags accepts at most ${MAX_TAGS} entries`);
  return tags;
}

/** @param {unknown} value @returns {string | undefined} */
function descriptionField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalid(`description must be a string (got ${formatValue(value)})`);
  }
  const description = value.trim();
  if (description.length === 0) return undefined;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw invalid(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return description;
}

/** @param {unknown} value @returns {number | undefined} */
function timestampField(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/**
 * @param {"HOST_INVALID" | "HOST_EXISTS" | "HOST_NOT_FOUND"} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function registryError(code, message) {
  const error = new Error(`dsh-remote: ${message}`);
  // @ts-ignore -- Error subclasses carry the machine-readable contract code.
  error.code = code;
  return error;
}

/** @param {string} message @returns {Error & { code: "HOST_INVALID" }} */
function invalid(message) {
  return registryError("HOST_INVALID", message);
}

/** @param {string} name @returns {Error & { code: "HOST_NOT_FOUND" }} */
function hostNotFound(name) {
  return registryError("HOST_NOT_FOUND", `managed host ${JSON.stringify(String(name ?? ""))} was not found`);
}

/** @param {ManagedHost} record @returns {ManagedHost} */
function cloneRecord(record) {
  return {
    ...record,
    ...(record.proxyJump === undefined ? {} : { proxyJump: [...record.proxyJump] }),
    ...(record.tags === undefined ? {} : { tags: [...record.tags] }),
  };
}

/**
 * @param {ManagedHost[]} records
 * @returns {ManagedHost[]}
 */
function sortByName(records) {
  return [...records].sort((left, right) => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
}

/** @param {string} path @returns {string} */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** @param {string} path @returns {string} */
function basenameOf(path) {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1];
}

/**
 * Drop undefined properties so persisted/returned records stay clean.
 *
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

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** @returns {void} */
function noop() {}
