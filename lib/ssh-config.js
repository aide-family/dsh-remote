/**
 * Minimal, allocation-friendly OpenSSH client-config parser.
 *
 * It understands the parts dsh-remote needs to discover hosts:
 *   - `Host` blocks, including several aliases on one line;
 *   - `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`;
 *   - `Include` directives (relative to the ssh config directory or absolute,
 *     recursive with a depth guard and cycle protection, `~` and glob support);
 *   - blank lines, `#` comments (whole-line and trailing), quoted values and
 *     case-insensitive keywords.
 *
 * Pattern aliases (`*`, `?`, `!`) cannot be resolved without a concrete target,
 * so their `Host` blocks are skipped: only literal aliases become hosts. As in
 * OpenSSH, the first value for each keyword wins and the first `Host` block
 * that defines an alias decides that alias.
 *
 * The parser is deliberately forgiving: a missing, unreadable, or malformed
 * file yields `[]` (or simply no extra hosts) and never throws. It does no
 * hostname expansion (`%h`, `%p`, ...) and no network access.
 *
 * @module lib/ssh-config
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** How many levels of `Include` nesting are followed before stopping. */
const MAX_INCLUDE_DEPTH = 8;

/** Characters that make an include path a glob pattern. */
const WILDCARD_RE = /[*?]/u;

/** Characters that must be escaped when building a RegExp source. */
const REGEXP_SPECIAL_CHARS = new Set("\\^$.*+?()[]{}|");

/**
 * One host discovered in an OpenSSH config file. `hosts.js` maps these to the
 * plugin-wide `RemoteHost` shape (id, source, defaults).
 *
 * @typedef {object} SshConfigHost
 * @property {string} name Host alias (lookup name).
 * @property {string} host HostName, or the alias itself when HostName is absent.
 * @property {number} [port] Port 1-65535 when configured.
 * @property {string} [username] User when configured.
 * @property {string} [identityFile] First IdentityFile, `~` preserved.
 * @property {string[]} [proxyJump] ProxyJump hops, `[user@]host[:port]` entries.
 */

/**
 * Parse an OpenSSH client config file into host records, sorted by name.
 *
 * Never throws: a missing/unreadable/unparsable file (or an empty path)
 * returns `[]`.
 *
 * @param {string} filePath Path to the config file; `~` is expanded from `homeDir`.
 * @param {{ homeDir?: string }} [options] `homeDir` overrides `os.homedir()` (tests).
 * @returns {SshConfigHost[]}
 */
export function loadSshConfig(filePath, options = {}) {
  const homeDir = typeof options?.homeDir === "string" ? options.homeDir : homedir();
  if (typeof filePath !== "string" || filePath.trim().length === 0) return [];

  const primaryPath = resolve(expandHome(filePath.trim(), homeDir));
  const includeRoot = dirname(primaryPath);

  /** @type {Set<string>} Absolute paths already parsed (include cycles). */
  const visited = new Set();
  /** @type {Map<string, SshConfigHost>} Lowercased alias -> first record. */
  const hosts = new Map();

  // The current *section* is shared across Include boundaries on purpose:
  // OpenSSH splices included files in place, so an included file that starts
  // with bare options (no Host line) still contributes to the enclosing block.
  /** @type {{ aliases: string[], options: Record<string, string | string[]> }} */
  const state = { aliases: [], options: {} };

  /**
   * @param {unknown} value
   * @returns {string[] | undefined}
   */
  const expandInclude = (value) => {
    const pattern = expandHome(String(value ?? "").trim(), homeDir);
    if (pattern.length === 0) return undefined;

    const target = isAbsolute(pattern) ? pattern : resolve(includeRoot, pattern);
    const directory = dirname(target);
    const patternBase = basename(target);

    if (!WILDCARD_RE.test(patternBase)) {
      return WILDCARD_RE.test(directory) ? undefined : [target];
    }
    // Only the final path segment may be a glob; nested globs are unsupported.
    if (WILDCARD_RE.test(directory)) return undefined;

    /** @type {string[]} */
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return undefined;
    }
    const matcher = globToRegExp(patternBase);
    return entries
      .filter((entry) => matcher.test(entry))
      .sort()
      .map((entry) => join(directory, entry));
  };

  /**
   * @param {string} key Lowercase keyword.
   * @param {string[]} values Keyword arguments.
   */
  const applyOption = (key, values) => {
    const options = state.options;
    const first = values[0]?.trim() ?? "";

    switch (key) {
      case "hostname":
        if (options.hostName === undefined && first.length > 0) options.hostName = first;
        break;
      case "user":
        if (options.username === undefined && first.length > 0) options.username = first;
        break;
      case "port":
        if (options.port === undefined && first.length > 0) options.port = first;
        break;
      case "identityfile":
        if (options.identityFile === undefined && first.length > 0) options.identityFile = first;
        break;
      case "proxyjump": {
        if (options.proxyJump !== undefined) break;
        /** @type {string[]} */
        const chain = [];
        for (const value of values) {
          for (const part of value.split(/[,\s]+/u)) {
            const hop = part.trim();
            if (hop.length === 0) continue;
            if (hop.toLowerCase() === "none") {
              chain.length = 0;
              continue;
            }
            chain.push(hop);
          }
        }
        if (chain.length > 0) options.proxyJump = chain;
        break;
      }
      default:
        break;
    }
  };

  /** Close the current `Host` block and record its literal aliases. */
  const flush = () => {
    const aliases = state.aliases;
    const options = state.options;
    state.aliases = [];
    state.options = {};

    if (aliases.length === 0) return;

    for (const rawAlias of aliases) {
      const name = rawAlias.trim();
      if (name.length === 0 || isPatternAlias(name)) continue;
      const key = name.toLowerCase();
      if (hosts.has(key)) continue; // first definition wins (OpenSSH semantics)

      const hostName = typeof options.hostName === "string" ? options.hostName.trim() : "";
      const host = hostName.length > 0 ? hostName : name;
      if (host.length === 0) continue;

      /** @type {SshConfigHost} */
      const record = { name, host };

      const port = parsePort(options.port);
      if (port !== undefined) record.port = port;

      if (typeof options.username === "string" && options.username.trim().length > 0) {
        record.username = options.username.trim();
      }
      if (typeof options.identityFile === "string" && options.identityFile.trim().length > 0) {
        record.identityFile = options.identityFile.trim();
      }
      if (Array.isArray(options.proxyJump) && options.proxyJump.length > 0) {
        record.proxyJump = [...options.proxyJump];
      }

      hosts.set(key, record);
    }
  };

  /**
   * @param {string} path
   * @param {number} depth
   */
  const parseFile = (path, depth) => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);

    /** @type {string} */
    let content;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      return; // missing / unreadable / not a file: ignore this include
    }

    for (const rawLine of content.split(/\r?\n/u)) {
      const tokens = splitConfigLine(rawLine);
      if (tokens.length === 0) continue;

      let keyword = tokens[0].toLowerCase();
      /** @type {string[]} */
      let values = tokens.slice(1);

      // Accept the `Keyword=value` form OpenSSH also allows.
      const equals = keyword.indexOf("=");
      if (equals > 0) {
        const inline = keyword.slice(equals + 1);
        keyword = keyword.slice(0, equals);
        if (inline.length > 0) values = [inline, ...values];
      }

      switch (keyword) {
        case "host":
          flush();
          state.aliases = values;
          break;
        case "match":
          // A `Match` block cannot be resolved without connection criteria.
          flush();
          break;
        case "include":
          for (const value of values) {
            const included = expandInclude(value);
            if (included === undefined) continue;
            for (const file of included) parseFile(file, depth + 1);
          }
          break;
        default:
          if (state.aliases.length > 0) applyOption(keyword, values);
          break;
      }
    }
  };

  parseFile(primaryPath, 0);
  flush();

  return [...hosts.values()].sort(compareByName);
}

/**
 * Split one config line into tokens, honoring double quotes and `#` comments.
 * Quoted values keep their spaces; `#` outside quotes starts a comment.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitConfigLine(line) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let started = false;
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === "\\" && index + 1 < line.length) {
        current += line[index + 1];
        index += 1;
        started = true;
        continue;
      }
      if (char === '"') {
        quoted = false;
        continue;
      }
      current += char;
      started = true;
      continue;
    }

    if (char === "#") break;
    if (char === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (char === "\\" && index + 1 < line.length) {
      const next = line[index + 1];
      if (next === " " || next === "\t" || next === '"' || next === "\\" || next === "#") {
        current += next;
        started = true;
        index += 1;
        continue;
      }
    }
    current += char;
    started = true;
  }

  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPatternAlias(value) {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parsePort(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const port = Number(text);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * @param {string} value
 * @param {string} homeDir
 * @returns {string}
 */
function expandHome(value, homeDir) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/**
 * @param {string} pattern Glob with `*` and `?`.
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += REGEXP_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "u");
}

/**
 * @param {SshConfigHost} left
 * @param {SshConfigHost} right
 * @returns {number}
 */
function compareByName(left, right) {
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}
