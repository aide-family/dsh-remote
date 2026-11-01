/**
 * dsh-remote configuration: Schemastery schema + programmatic normalization.
 *
 * `Config` is the schema the DSH loader validates the plugin config with (it
 * also drives the settings UI). `normalizeConfig(raw)` is the plain-JS
 * counterpart used by `lib/index.js` and unit tests: it fills the same defaults
 * and performs the semantic checks a schema cannot express well (unique host
 * names, environment-variable *names* instead of secrets, numeric ranges).
 *
 * This module is pure: no filesystem, environment, or network access. Host
 * discovery (`~/.ssh/config` reading) lives in `lib/ssh-config.js`/`lib/hosts.js`.
 */

import Schema from "@deepseek-ai/schemastery";

/** `~/.ssh/config` default location (expanded by the host loader). */
export const DEFAULT_SSH_CONFIG_PATH = "~/.ssh/config";

/** Approval policies: auto (approve mutating actions), always, never. */
export const APPROVAL_POLICIES = Object.freeze(["auto", "always", "never"]);

/** Known-host verification modes. */
export const KNOWN_HOSTS_POLICIES = Object.freeze(["tofu", "strict", "insecure"]);

/** What `policy: auto` does with commands the static classifier cannot prove read-only. */
export const UNPROVEN_COMMAND_POLICIES = Object.freeze(["allow", "ask"]);

/**
 * Environment variables are referenced by NAME; this is the accepted shape.
 * A config value that does not match (a number, a real password, an empty
 * string) is rejected so a secret can never be pasted into the config file.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Defaults from `docs/ARCHITECTURE.md` ("Hosts contract", config fields). */
const DEFAULTS = Object.freeze({
  hosts: Object.freeze([]),
  includeSshConfig: true,
  sshConfigPath: DEFAULT_SSH_CONFIG_PATH,
  hostRegistryPath: "",
  policy: "auto",
  readonlyHosts: Object.freeze([]),
  allowHosts: Object.freeze([]),
  denyCommandPatterns: Object.freeze([]),
  connectTimeoutMs: 20_000,
  execTimeoutMs: 120_000,
  maxOutputBytes: 200_000,
  maxReadBytes: 800_000,
  maxTransferBytes: 52_428_800,
  knownHostsPolicy: "tofu",
  allowLocalOutsideWorkspace: false,
  promptGuidance: true,
  terminalEnabled: true,
  userTerminal: true,
  userTerminalTtlMs: 1_800_000,
  userTerminalReconnectAttempts: 5,
  userTerminalScrollbackBytes: 400_000,
  managementApi: true,
  unprovenCommands: "allow",
  liveTerminal: true,
  autoOpenLiveTerminal: true,
  devLiveEvents: false,
  terminalRows: 40,
  terminalCols: 120,
  terminalIdleSilenceMs: 800,
  terminalTimeoutMs: 30_000,
  terminalStartupTimeoutMs: 15_000,
  terminalScrollbackLines: 2_000,
  terminalScrollbackBytes: 2_000_000,
  terminalMaxReadBytes: 262_144,
});

/**
 * One entry of `config.hosts`: connection coordinates plus *references* to
 * credentials (environment-variable names), never the credentials themselves.
 *
 * @typedef {object} ConfiguredHost
 * @property {string} name Unique lookup name the model uses (no whitespace).
 * @property {string} host Hostname or IP address to connect to.
 * @property {number} [port] SSH port, 1-65535 (default 22).
 * @property {string} [username] Login user.
 * @property {string} [identityFile] Private key path; `~` is allowed.
 * @property {string} [passwordEnv] Environment-variable NAME holding the password.
 * @property {string} [passphraseEnv] Environment-variable NAME holding the key passphrase.
 * @property {string[]} [proxyJump] ProxyJump chain, `[user@]host[:port]` entries.
 * @property {string[]} [tags] Freeform tags surfaced by `remote_hosts`.
 * @property {string} [description] Human description surfaced by `remote_hosts`.
 */

const ConfiguredHostSchema = Schema.object({
  name: Schema.string()
    .required()
    .description("Unique lookup name the model uses (no whitespace)."),
  host: Schema.string()
    .required()
    .description("Hostname or IP address to connect to."),
  port: Schema.natural()
    .min(1)
    .max(65_535)
    .default(22)
    .description("SSH port (1-65535, default 22)."),
  username: Schema.string().description("Login user."),
  identityFile: Schema.string().description("Private key path; `~` is allowed."),
  passwordEnv: Schema.string()
    .pattern(ENV_NAME_RE)
    .description("Environment variable NAME holding the password (never the value)."),
  passphraseEnv: Schema.string()
    .pattern(ENV_NAME_RE)
    .description("Environment variable NAME holding the key passphrase (never the value)."),
  proxyJump: Schema.array(Schema.string()).description(
    "ProxyJump chain entries, `[user@]host[:port]`.",
  ),
  tags: Schema.array(Schema.string()).description("Freeform tags shown by `remote_hosts`."),
  description: Schema.string().description("Human description shown by `remote_hosts`."),
});

/**
 * Plugin configuration schema. Empty config is valid: every field has a
 * default, so `apply(ctx)` works with no config block at all.
 */
export const Config = Schema.object({
  hosts: Schema.array(ConfiguredHostSchema).default([]).description(
    "Configured hosts (in addition to ~/.ssh/config). Config entries win on name collisions.",
  ),
  includeSshConfig: Schema.boolean()
    .default(DEFAULTS.includeSshConfig)
    .description("Discover hosts from the OpenSSH client config."),
  sshConfigPath: Schema.string()
    .default(DEFAULTS.sshConfigPath)
    .description("OpenSSH client config path; `~` is allowed."),
  hostRegistryPath: Schema.string()
    .default(DEFAULTS.hostRegistryPath)
    .description("Managed-host registry file; empty means `$DSH_HOME/remote/hosts.json`."),
  policy: Schema.union(APPROVAL_POLICIES.map((value) => Schema.const(value)))
    .default(DEFAULTS.policy)
    .description("Approval policy: auto asks for mutating actions, always asks for everything, never denies mutating actions."),
  readonlyHosts: Schema.array(Schema.string())
    .default([])
    .description("Host-name globs (* and ?) whose mutating actions are always denied."),
  allowHosts: Schema.array(Schema.string())
    .default([])
    .description("Host-name globs (* and ?) that may be used; empty means every host."),
  denyCommandPatterns: Schema.array(Schema.string())
    .default([])
    .description("RegExp sources; a matching remote command is denied outright."),
  connectTimeoutMs: Schema.natural()
    .min(1)
    .default(DEFAULTS.connectTimeoutMs)
    .description("TCP/banner connect timeout in milliseconds."),
  execTimeoutMs: Schema.natural()
    .min(1)
    .default(DEFAULTS.execTimeoutMs)
    .description("Default remote command timeout in milliseconds."),
  maxOutputBytes: Schema.natural()
    .min(1)
    .default(DEFAULTS.maxOutputBytes)
    .description("Per-stream cap for remote command output (tail kept)."),
  maxReadBytes: Schema.natural()
    .min(1)
    .default(DEFAULTS.maxReadBytes)
    .description("Cap for one `remote_read` file read."),
  maxTransferBytes: Schema.natural()
    .min(1)
    .default(DEFAULTS.maxTransferBytes)
    .description("Cap for one upload/download."),
  knownHostsPolicy: Schema.union(KNOWN_HOSTS_POLICIES.map((value) => Schema.const(value)))
    .default(DEFAULTS.knownHostsPolicy)
    .description("Host-key verification: tofu, strict, or insecure."),
  allowLocalOutsideWorkspace: Schema.boolean()
    .default(DEFAULTS.allowLocalOutsideWorkspace)
    .description("Allow `remote_transfer` local paths outside the session workspace."),
  promptGuidance: Schema.boolean()
    .default(DEFAULTS.promptGuidance)
    .description("Contribute the dsh-remote system-prompt section."),
  terminalEnabled: Schema.boolean()
    .default(DEFAULTS.terminalEnabled)
    .description("Register the persistent remote-shell tools (remote_shell_*)."),
  userTerminal: Schema.boolean()
    .default(DEFAULTS.userTerminal)
    .description(
      "Serve the user-driven interactive SSH terminal: the relay socket, the terminal.* management API and the browser panel.",
    ),
  userTerminalTtlMs: Schema.natural()
    .min(0)
    .default(DEFAULTS.userTerminalTtlMs)
    .description(
      "Idle time (ms) after the last terminal bridge detaches before the SSH session is closed; 0 keeps it open.",
    ),
  userTerminalReconnectAttempts: Schema.natural()
    .min(1)
    .default(DEFAULTS.userTerminalReconnectAttempts)
    .description("Automatic SSH reconnect attempts after a drop in the user terminal."),
  userTerminalScrollbackBytes: Schema.natural()
    .min(1)
    .default(DEFAULTS.userTerminalScrollbackBytes)
    .description("Replay buffer (bytes) retained for a reattached user terminal."),
  managementApi: Schema.boolean()
    .default(DEFAULTS.managementApi)
    .description("Serve the browser management API (/dsh-remote/api) when a web server is mounted."),
  unprovenCommands: Schema.union(UNPROVEN_COMMAND_POLICIES.map((value) => Schema.const(value)))
    .default(DEFAULTS.unprovenCommands)
    .description(
      'Under policy "auto", how to treat commands the classifier cannot prove read-only: "allow" runs them without approval (only provably mutating commands ask), "ask" requires approval.',
    ),
  liveTerminal: Schema.boolean()
    .default(DEFAULTS.liveTerminal)
    .description("Serve the live command stream (/dsh-remote/live) and register the right-sidebar terminal."),
  autoOpenLiveTerminal: Schema.boolean()
    .default(DEFAULTS.autoOpenLiveTerminal)
    .description("Open the right-sidebar terminal automatically when a remote command starts."),
  devLiveEvents: Schema.boolean()
    .default(DEFAULTS.devLiveEvents)
    .description("Expose the dev-only live-event injector on the management API (testing; keep off in production)."),
  terminalRows: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalRows)
    .description("PTY rows requested for remote shell sessions."),
  terminalCols: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalCols)
    .description("PTY columns requested for remote shell sessions."),
  terminalIdleSilenceMs: Schema.natural()
    .min(50)
    .default(DEFAULTS.terminalIdleSilenceMs)
    .description("Output silence (ms) that settles a remote-shell send as inferred-idle."),
  terminalTimeoutMs: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalTimeoutMs)
    .description("Absolute bound (ms) on one remote-shell send wait."),
  terminalStartupTimeoutMs: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalStartupTimeoutMs)
    .description("Bound (ms) on remote-shell startup before the session publishes."),
  terminalScrollbackLines: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalScrollbackLines)
    .description("Retained remote-shell scrollback lines."),
  terminalScrollbackBytes: Schema.natural()
    .min(1)
    .default(DEFAULTS.terminalScrollbackBytes)
    .description("Retained remote-shell scrollback byte cap."),
  terminalMaxReadBytes: Schema.natural()
    .min(64)
    .default(DEFAULTS.terminalMaxReadBytes)
    .description("Byte cap for one remote_shell_read/remote_shell_send result."),
});

/**
 * Validate and normalize a raw plugin config into a defaults-filled plain
 * object. Safe to call with `undefined` (or with an already-normalized object:
 * it is idempotent). Never performs I/O.
 *
 * @param {unknown} [raw]
 * @returns {{
 *   hosts: ConfiguredHost[],
 *   includeSshConfig: boolean,
 *   sshConfigPath: string,
 *   hostRegistryPath: string,
 *   policy: "auto" | "always" | "never",
 *   readonlyHosts: string[],
 *   allowHosts: string[],
 *   denyCommandPatterns: string[],
 *   connectTimeoutMs: number,
 *   execTimeoutMs: number,
 *   maxOutputBytes: number,
 *   maxReadBytes: number,
 *   maxTransferBytes: number,
 *   knownHostsPolicy: "tofu" | "strict" | "insecure",
 *   allowLocalOutsideWorkspace: boolean,
 *   promptGuidance: boolean,
 *   terminalEnabled: boolean,
 *   userTerminal: boolean,
 *   userTerminalTtlMs: number,
 *   userTerminalReconnectAttempts: number,
 *   userTerminalScrollbackBytes: number,
 *   managementApi: boolean,
 *   unprovenCommands: "allow" | "ask",
 *   liveTerminal: boolean,
 *   autoOpenLiveTerminal: boolean,
 *   devLiveEvents: boolean,
 *   terminalRows: number,
 *   terminalCols: number,
 *   terminalIdleSilenceMs: number,
 *   terminalTimeoutMs: number,
 *   terminalStartupTimeoutMs: number,
 *   terminalScrollbackLines: number,
 *   terminalScrollbackBytes: number,
 *   terminalMaxReadBytes: number,
 * }}
 */
export function normalizeConfig(raw) {
  const source = readObject(raw);

  return {
    hosts: normalizeHosts(source),
    includeSshConfig: booleanField(source, "includeSshConfig", DEFAULTS.includeSshConfig),
    sshConfigPath: pathField(source, "sshConfigPath", DEFAULTS.sshConfigPath),
    hostRegistryPath: registryPathField(source, "hostRegistryPath", DEFAULTS.hostRegistryPath),
    policy: enumField(source, "policy", DEFAULTS.policy, APPROVAL_POLICIES),
    readonlyHosts: stringListField(source, "readonlyHosts"),
    allowHosts: stringListField(source, "allowHosts"),
    denyCommandPatterns: stringListField(source, "denyCommandPatterns"),
    connectTimeoutMs: positiveIntegerField(source, "connectTimeoutMs", DEFAULTS.connectTimeoutMs),
    execTimeoutMs: positiveIntegerField(source, "execTimeoutMs", DEFAULTS.execTimeoutMs),
    maxOutputBytes: positiveIntegerField(source, "maxOutputBytes", DEFAULTS.maxOutputBytes),
    maxReadBytes: positiveIntegerField(source, "maxReadBytes", DEFAULTS.maxReadBytes),
    maxTransferBytes: positiveIntegerField(source, "maxTransferBytes", DEFAULTS.maxTransferBytes),
    knownHostsPolicy: enumField(
      source,
      "knownHostsPolicy",
      DEFAULTS.knownHostsPolicy,
      KNOWN_HOSTS_POLICIES,
    ),
    allowLocalOutsideWorkspace: booleanField(
      source,
      "allowLocalOutsideWorkspace",
      DEFAULTS.allowLocalOutsideWorkspace,
    ),
    promptGuidance: booleanField(source, "promptGuidance", DEFAULTS.promptGuidance),
    terminalEnabled: booleanField(source, "terminalEnabled", DEFAULTS.terminalEnabled),
    userTerminal: booleanField(source, "userTerminal", DEFAULTS.userTerminal),
    userTerminalTtlMs: nonNegativeIntegerField(
      source,
      "userTerminalTtlMs",
      DEFAULTS.userTerminalTtlMs,
    ),
    userTerminalReconnectAttempts: positiveIntegerField(
      source,
      "userTerminalReconnectAttempts",
      DEFAULTS.userTerminalReconnectAttempts,
    ),
    userTerminalScrollbackBytes: positiveIntegerField(
      source,
      "userTerminalScrollbackBytes",
      DEFAULTS.userTerminalScrollbackBytes,
    ),
    managementApi: booleanField(source, "managementApi", DEFAULTS.managementApi),
    unprovenCommands: enumField(
      source,
      "unprovenCommands",
      DEFAULTS.unprovenCommands,
      UNPROVEN_COMMAND_POLICIES,
    ),
    liveTerminal: booleanField(source, "liveTerminal", DEFAULTS.liveTerminal),
    autoOpenLiveTerminal: booleanField(
      source,
      "autoOpenLiveTerminal",
      DEFAULTS.autoOpenLiveTerminal,
    ),
    devLiveEvents: booleanField(source, "devLiveEvents", DEFAULTS.devLiveEvents),
    terminalRows: positiveIntegerField(source, "terminalRows", DEFAULTS.terminalRows),
    terminalCols: positiveIntegerField(source, "terminalCols", DEFAULTS.terminalCols),
    terminalIdleSilenceMs: positiveIntegerField(
      source,
      "terminalIdleSilenceMs",
      DEFAULTS.terminalIdleSilenceMs,
    ),
    terminalTimeoutMs: positiveIntegerField(
      source,
      "terminalTimeoutMs",
      DEFAULTS.terminalTimeoutMs,
    ),
    terminalStartupTimeoutMs: positiveIntegerField(
      source,
      "terminalStartupTimeoutMs",
      DEFAULTS.terminalStartupTimeoutMs,
    ),
    terminalScrollbackLines: positiveIntegerField(
      source,
      "terminalScrollbackLines",
      DEFAULTS.terminalScrollbackLines,
    ),
    terminalScrollbackBytes: positiveIntegerField(
      source,
      "terminalScrollbackBytes",
      DEFAULTS.terminalScrollbackBytes,
    ),
    terminalMaxReadBytes: positiveIntegerField(
      source,
      "terminalMaxReadBytes",
      DEFAULTS.terminalMaxReadBytes,
    ),
  };
}

/**
 * Normalize one configured host, rejecting malformed entries with an error that
 * names the offending host (or at least its index).
 *
 * @param {unknown} entry
 * @param {number} index
 * @returns {ConfiguredHost}
 */
function normalizeHostEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw configError(`hosts[${index}] must be an object`);
  }

  const name = requiredString(entry, "name", `hosts[${index}]`);
  if (/\s/u.test(name)) {
    throw configError(`host ${quote(name)}: name must not contain whitespace`);
  }
  const label = `host ${quote(name)}`;

  const host = requiredString(entry, "host", label);
  if (/\s/u.test(host)) {
    throw configError(`${label}: host must not contain whitespace`);
  }

  const portValue = entry.port;
  const port = portValue === undefined || portValue === null ? 22 : portValue;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw configError(
      `${label}: port must be an integer between 1 and 65535 (got ${formatValue(portValue)})`,
    );
  }

  const normalized = {
    name,
    host,
    port,
    username: optionalString(entry, "username", label),
    identityFile: optionalString(entry, "identityFile", label),
    passwordEnv: envNameField(entry, "passwordEnv", label),
    passphraseEnv: envNameField(entry, "passphraseEnv", label),
    proxyJump: proxyJumpField(entry, label),
    tags: tagsField(entry, label),
    description: optionalString(entry, "description", label),
  };

  return compact(normalized);
}

/**
 * @param {Record<string, unknown>} source
 * @returns {ConfiguredHost[]}
 */
function normalizeHosts(source) {
  const value = source.hosts;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw configError("hosts must be an array of host objects");
  }

  const seen = new Map();
  const hosts = [];
  for (let index = 0; index < value.length; index += 1) {
    const host = normalizeHostEntry(value[index], index);
    const key = host.name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw configError(
        `duplicate host name ${quote(host.name)} in hosts[${index}] (already defined by hosts[${previous}]); host names must be unique`,
      );
    }
    seen.set(key, index);
    hosts.push(host);
  }
  return hosts;
}

/** @param {unknown} raw @returns {Record<string, unknown>} */
function readObject(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(`config must be an object (got ${formatValue(raw)})`);
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} label
 * @returns {string}
 */
function requiredString(source, key, label) {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${label}: ${key} must be a non-empty string (got ${formatValue(value)})`);
  }
  return value.trim();
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} label
 * @returns {string | undefined}
 */
function optionalString(source, key, label) {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${label}: ${key} must be a non-empty string (got ${formatValue(value)})`);
  }
  return value.trim();
}

/**
 * `passwordEnv`/`passphraseEnv` hold environment-variable NAMES. Reject values
 * that cannot be a variable name (numbers, booleans, empty strings, or an
 * actual pasted secret with spaces) so secrets never live in the config file.
 *
 * @param {Record<string, unknown>} source
 * @param {"passwordEnv" | "passphraseEnv"} key
 * @param {string} label
 * @returns {string | undefined}
 */
function envNameField(source, key, label) {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ENV_NAME_RE.test(value.trim())) {
    throw configError(
      `${label}: ${key} must be the NAME of an environment variable ` +
        `(e.g. "PROD_PASSWORD", matching ${ENV_NAME_RE.source}) — never the secret value itself ` +
        `(got ${formatValue(value)})`,
    );
  }
  return value.trim();
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} label
 * @returns {string[] | undefined}
 */
function proxyJumpField(source, label) {
  const value = source.proxyJump;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw configError(
      `${label}: proxyJump must be an array of "[user@]host[:port]" strings (got ${formatValue(value)})`,
    );
  }
  return value.map((hop, index) => {
    if (typeof hop !== "string" || hop.trim() === "") {
      throw configError(
        `${label}: proxyJump[${index}] must be a non-empty string (got ${formatValue(hop)})`,
      );
    }
    return hop.trim();
  });
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} label
 * @returns {string[] | undefined}
 */
function tagsField(source, label) {
  const value = source.tags;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw configError(`${label}: tags must be an array of strings (got ${formatValue(value)})`);
  }
  return value.map((tag, index) => {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw configError(`${label}: tags[${index}] must be a non-empty string`);
    }
    return tag.trim();
  });
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {boolean} fallback
 * @param {readonly string[]} allowed
 * @returns {string}
 */
function enumField(source, key, fallback, allowed) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw configError(`${key} must be one of ${allowed.map((item) => quote(item)).join(", ")} (got ${formatValue(value)})`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function booleanField(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw configError(`${key} must be a boolean (got ${formatValue(value)})`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntegerField(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw configError(`${key} must be a positive integer (got ${formatValue(value)})`);
  }
  return value;
}

/**
 * Zero-or-more integer (0 has a documented meaning for some timeouts: it
 * disables the corresponding idle/expiry behavior).
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeIntegerField(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw configError(`${key} must be a non-negative integer (got ${formatValue(value)})`);
  }
  return value;
}

/**
 * A list of glob patterns / RegExp sources / freeform strings. Entries are
 * trimmed and must be non-empty strings; globs are otherwise unrestricted
 * because the host matcher treats every non-`*`/`?` character literally.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @returns {string[]}
 */
function stringListField(source, key) {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw configError(`${key} must be an array of strings (got ${formatValue(value)})`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw configError(`${key}[${index}] must be a non-empty string (got ${formatValue(entry)})`);
    }
    return entry.trim();
  });
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function pathField(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${key} must be a non-empty path string (got ${formatValue(value)})`);
  }
  return value.trim();
}

/**
 * A filesystem path. An empty string is preserved (for fields where the empty
 * string has a documented meaning such as "use the default location").
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function registryPathField(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw configError(`${key} must be a path string (got ${formatValue(value)})`);
  }
  return value.trim();
}

/**
 * Drop undefined properties so normalized objects compare cleanly and never
 * carry `key: undefined` placeholders.
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

/** @param {string} message @returns {Error} */
function configError(message) {
  return new Error(`dsh-remote: ${message}`);
}

/** @param {string} value @returns {string} */
function quote(value) {
  return JSON.stringify(value);
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return "array";
  return typeof value;
}

