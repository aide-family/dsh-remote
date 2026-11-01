/**
 * Node/bridge launch resolution for the interactive SSH terminal (v0.5.1).
 *
 * The browser types `relay.open().shell.command` into DSH's native terminal
 * (a plain interactive shell), so that line must not depend on the terminal's
 * `PATH`: a packaged Desktop app (Electron) has no `node` there, and
 * `VAR=value command` is a syntax error in fish. This module therefore resolves
 * a *direct* node binary — or, as a last resort, `bin/dsh-remote-terminal`,
 * which resolves node itself — and builds the exact `exec …` line:
 *
 *   exec '<node>' '<lib/terminal/bridge.cjs>' --host '…' --session '…' --socket '…'
 *   exec env ELECTRON_RUN_AS_NODE=1 '/…/Contents/MacOS/App' '<bridge.cjs>' --host …
 *   exec '<abs>/bin/dsh-remote-terminal' --host '…' --session '…' --socket '…'
 *
 * Resolution order (binding: docs/ARCHITECTURE.md, "v0.5.1"):
 *  1. `$DSH_REMOTE_NODE` when it names an existing executable;
 *  2. `execPath` directly when the Host does not run under Electron;
 *  3. `env ELECTRON_RUN_AS_NODE=1 <execPath>` when Electron and a one-shot
 *     `<execPath> --version` probe with that env succeeds (cached per path);
 *  4. a bundled runtime node next to `execPath` (macOS `Contents/Resources`
 *     and the Windows/Linux `resources/` layouts);
 *  5. `'<abs>/bin/dsh-remote-terminal'` (the POSIX launcher fallback).
 *
 * Pure apart from the pluggable defaults: every branch can be injected
 * (`env`, `execPath`, `versions`, `platform`, `existsSync`,
 * `probeElectronRunAsNode`), so unit tests never spawn a process.
 */

import { spawnSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable that forces the node executable used by the bridge. */
export const NODE_ENV_VAR = "DSH_REMOTE_NODE";
/** Environment variable that makes an Electron binary behave as node. */
export const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";
/** Upper bound for the one-shot Electron run-as-node probe. */
const PROBE_TIMEOUT_MS = 5_000;

/** @type {Map<string, boolean>} execPath -> probe result (one spawn per path) */
const probeCache = new Map();

/**
 * POSIX single-quote a value for `/bin/sh`, bash, zsh and fish.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** Absolute path of the packaged launcher (the fallback command). */
export function defaultLauncherPath() {
  return fileURLToPath(new URL("../../bin/dsh-remote-terminal", import.meta.url));
}

/** Absolute path of the CommonJS bridge the native terminal must run. */
export function defaultBridgePath() {
  return fileURLToPath(new URL("./bridge.cjs", import.meta.url));
}

/**
 * Bundled runtime node candidates next to an Electron `execPath`.
 *
 * macOS: `<app>/Contents/Resources/runtime/...`; Windows/Linux:
 * `<app-dir>/resources/runtime/...` (Electron's packaged layout).
 *
 * @param {string} execPath
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function bundledNodeCandidates(execPath, platform = process.platform) {
  const binary = platform === "win32" ? "node.exe" : "node";
  // Join with the *target* platform's rules: the Windows layout must stay
  // `C:\\…` even when this module is exercised on POSIX in tests.
  const join = platform === "win32" ? path.win32.join : path.join;
  const dirname = platform === "win32" ? path.win32.dirname : path.dirname;
  /** @type {string} */
  let runtimeRoot;
  const contents = /^(.*)[/\\]Contents[/\\]MacOS[/\\][^/\\]+$/u.exec(execPath);
  if (contents) {
    runtimeRoot = join(contents[1], "Contents", "Resources");
  } else if (platform === "darwin") {
    runtimeRoot = join(dirname(execPath), "Resources");
  } else {
    runtimeRoot = join(dirname(execPath), "resources");
  }
  return [
    join(runtimeRoot, "runtime", "bin", binary),
    join(runtimeRoot, "runtime", "primary-runtime", "dependencies", "node", "bin", binary),
  ];
}

/**
 * One-shot probe: does `<execPath> --version` succeed with
 * `ELECTRON_RUN_AS_NODE=1`? Cached per path so a Host process spawns at most
 * one probe. Never throws, never prints.
 *
 * @param {string} execPath
 * @returns {boolean}
 */
export function probeElectronRunAsNode(execPath) {
  const key = String(execPath ?? "");
  if (probeCache.has(key)) return probeCache.get(key) === true;
  let ok = false;
  try {
    const result = spawnSync(key, ["--version"], {
      env: { ...process.env, [ELECTRON_RUN_AS_NODE_ENV]: "1" },
      timeout: PROBE_TIMEOUT_MS,
      stdio: "ignore",
      windowsHide: true,
    });
    ok = result !== null && result.status === 0 && result.error === undefined;
  } catch {
    ok = false;
  }
  probeCache.set(key, ok);
  return ok;
}

/**
 * Resolve how the native terminal should launch the bridge.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] process environment
 * @param {string} [options.execPath] current executable (the Host binary)
 * @param {NodeJS.ProcessVersions} [options.versions] `process.versions`
 * @param {NodeJS.Platform} [options.platform] target platform
 * @param {(candidate: string) => boolean} [options.existsSync] existence probe
 * @param {(execPath: string) => boolean} [options.probeElectronRunAsNode] one-shot probe
 * @returns {{ prefix: string, kind: "env"|"node"|"electron-run-as-node"|"bundled"|"launcher", launcher: boolean }}
 */
export function resolveNodeLaunch(options = {}) {
  const {
    env = process.env,
    execPath = process.execPath,
    versions = process.versions,
    platform = process.platform,
    existsSync = fsExistsSync,
    probeElectronRunAsNode: probe = probeElectronRunAsNode,
  } = options ?? {};
  const exists = (candidate) => {
    try {
      return typeof candidate === "string" && candidate.length > 0 && existsSync(candidate) === true;
    } catch {
      return false;
    }
  };
  const configured = typeof env?.[NODE_ENV_VAR] === "string" ? env[NODE_ENV_VAR].trim() : "";
  if (configured.length > 0 && exists(configured)) {
    return { prefix: shellQuote(configured), kind: "env", launcher: false };
  }
  const nodePath = typeof execPath === "string" ? execPath : "";
  if (nodePath.length > 0 && !versions?.electron) {
    return { prefix: shellQuote(nodePath), kind: "node", launcher: false };
  }
  if (nodePath.length > 0 && versions?.electron) {
    let probed = false;
    try {
      probed = probe(nodePath) === true;
    } catch {
      probed = false;
    }
    if (probed) {
      return {
        prefix: `env ${ELECTRON_RUN_AS_NODE_ENV}=1 ${shellQuote(nodePath)}`,
        kind: "electron-run-as-node",
        launcher: false,
      };
    }
    for (const candidate of bundledNodeCandidates(nodePath, platform)) {
      if (exists(candidate)) return { prefix: shellQuote(candidate), kind: "bundled", launcher: false };
    }
  }
  return { prefix: shellQuote(defaultLauncherPath()), kind: "launcher", launcher: true };
}

/**
 * `resolveNodeLaunch(...).prefix` — the shell command prefix before the bridge
 * path. Every branch returns an already-quoted POSIX shell word (or `env …`).
 *
 * @param {Parameters<typeof resolveNodeLaunch>[0]} [options]
 * @returns {string}
 */
export function resolveNodeLauncher(options = {}) {
  return resolveNodeLaunch(options).prefix;
}

/**
 * Build the exact shell line the native terminal types. Every value is shell
 * quoted; the launcher fallback keeps its own bridge path (the launcher execs
 * `lib/terminal/bridge.cjs` itself).
 *
 * @param {object} options
 * @param {string} options.host remote host name
 * @param {string} options.session conversation session id
 * @param {string} options.socket relay socket/pipe path
 * @param {{ prefix: string, launcher: boolean }} options.launch resolved launch
 * @returns {string}
 */
export function buildBridgeCommand({ host, session, socket, launch } = /** @type {any} */ ({})) {
  if (launch === null || launch === undefined || typeof launch.prefix !== "string" || launch.prefix.length === 0) {
    throw new TypeError("buildBridgeCommand: a resolved launch with a prefix is required");
  }
  const parts = ["exec", launch.prefix];
  if (launch.launcher !== true) parts.push(shellQuote(defaultBridgePath()));
  parts.push("--host", shellQuote(host), "--session", shellQuote(session), "--socket", shellQuote(socket));
  return parts.join(" ");
}
