/**
 * Per-conversation interactive SSH terminal relay (v0.5).
 *
 * Owns at most one SSH PTY per `(conversation session id, host name)` and serves
 * DSH's native terminal through a local socket. `relay.open().shell.command` is
 * the exact shell line the browser types; it runs `bin/dsh-remote-terminal`
 * (which execs `lib/terminal/bridge.cjs`), and that bridge pipes raw bytes
 * between the socket and the terminal. Binding contract: docs/ARCHITECTURE.md,
 * "Relay + bridge".
 *
 * The socket server (handshake, frame parsing, replay write) lives in
 * `./relay-socket.js`; this module owns the PTY lifecycle, the bounded replay
 * ring, reconnect/backoff, the idle TTL and the audit trail. It never imports
 * `@deepseek-ai/*`, so unit tests run without DSH.
 */

import path from "node:path";

import { utf8Tail } from "./scrollback.js";
import { createBridgeServer, defaultRelaySocketPath, makeLogger } from "./relay-socket.js";
import { buildBridgeCommand, resolveNodeLaunch } from "./node-launcher.js";
import { authorizeConnectionLogin, runConnectionLogin } from "./connection-login.js";
import { targetConnectionDigest } from "../target-binding.js";

export { defaultRelaySocketPath, resolveHarnessHome } from "./relay-socket.js";
export { defaultBridgePath, defaultLauncherPath, shellQuote } from "./node-launcher.js";

/** Session id used by `open()` when the caller passes none. */
export const DEFAULT_SESSION_ID = "default";
/** Clear screen + scrollback and home the cursor (sent on every attach). */
export const CLEAR_SCREEN_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
/** Reconnect delays in ms; the last entry repeats for later attempts. */
export const RECONNECT_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
/** Default idle TTL after the last bridge detaches (0 disables it). */
export const DEFAULT_USER_TERMINAL_TTL_MS = 1_800_000;
/** Default reconnect attempts after an unexpected PTY exit. */
export const DEFAULT_USER_TERMINAL_RECONNECT_ATTEMPTS = 5;
/** Default bounded replay buffer size in bytes. */
export const DEFAULT_USER_TERMINAL_SCROLLBACK_BYTES = 400_000;
/** TERM requested for every relay PTY. */
export const RELAY_PTY_TERM = "xterm-256color";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const BANNER_RECONNECTING = "\x1b[33m[dsh-remote] SSH 连接已断开，正在重连…\x1b[0m\r\n";
const BANNER_RESTORED = "\x1b[32m[dsh-remote] SSH 连接已恢复\x1b[0m\r\n";
const BANNER_EXHAUSTED = "\x1b[31m[dsh-remote] SSH 连接已断开，重连尝试已用尽。\x1b[0m\r\n";
const BANNER_CLOSED = "\x1b[33m[dsh-remote] 终端会话已关闭。\x1b[0m\r\n";

/**
 * @typedef {object} TerminalSessionView
 * @property {string} sessionKey
 * @property {string} host
 * @property {string} target
 * @property {string} sessionId
 * @property {"connecting"|"connected"|"reconnecting"|"closed"|"error"} state
 * @property {number} attached
 * @property {number} reconnectAttempt
 * @property {number} cols
 * @property {number} rows
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string|null} lastError
 * @property {number} bytesOut
 * @property {number} bytesIn
 * @property {number} attachCount
 * @property {number|null} lastAttachAt
 * @property {number|null} lastDetachAt
 * @property {boolean} sharedWithAgent Whether this PTY is also owned by an Agent shell session.
 */

/**
 * Internal session entry (one per session key).
 *
 * @typedef {object} RelayEntry
 * @property {string} sessionKey
 * @property {any} host
 * @property {string} hostName
 * @property {string} target
 * @property {string} sessionId
 * @property {TerminalSessionView["state"]} state
 * @property {any} pty
 * @property {number} reconnectAttempt
 * @property {number} cols
 * @property {number} rows
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string|null} lastError
 * @property {number} bytesOut
 * @property {number} bytesIn
 * @property {number} attachCount
 * @property {number|null} lastAttachAt
 * @property {number|null} lastDetachAt
 * @property {string[]} chunks
 * @property {number} replayBytes
 * @property {Promise<void>|null} ready
 * @property {AbortController|null} abort
 * @property {NodeJS.Timeout|null} ttlTimer
 * @property {NodeJS.Timeout|null} reconnectTimer
 * @property {(() => void)|null} detachData
 * @property {(() => void)|null} detachExit
 */

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}
/** @param {unknown} value @param {number} fallback @returns {number} */
function nonNegativeInt(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}
/** @param {string} message @param {string} code @returns {Error & { code: string }} */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}
/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function checkRequest(signal) {
  if (signal?.aborted) throw codedError("Terminal open cancelled", "TERMINAL_CANCELLED");
}
/** Cancel only this caller's wait; ownership decides whether the connection is closed. */
function waitForRequest(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(codedError("Terminal open cancelled", "TERMINAL_CANCELLED")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
/** @param {unknown} value @returns {string} */
function normalizeSessionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : DEFAULT_SESSION_ID;
}
/** `user@host:port` label (identical to the transport's `targetLabel`). */
function targetLabel(host) {
  const user = typeof host?.username === "string" && host.username ? host.username : "";
  const hostname = host?.host ? String(host.host) : "?";
  const port = Number(host?.port) > 0 ? Number(host.port) : 22;
  return `${user ? `${user}@` : ""}${hostname}:${port}`;
}
/**
 * Create the terminal relay. See the module docstring for the contract.
 *
 * @param {object} deps
 * @param {any} deps.transport SSH transport with `openPty(host, options)`
 * @param {any} deps.hosts host store with `find(query)` / `isAllowed(host)`
 * @param {object} [deps.config] normalized plugin config (`userTerminal*` fields)
 * @param {any} [deps.audit] audit log with `record(entry)` (optional)
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @param {string} [deps.socketPath] override the socket path (tests / wiring)
 * @param {object} [deps.launcher] node-launcher options override (tests: pure, no spawn)
 */
export function createTerminalRelay({ transport, hosts, config, audit, logger, socketPath, launcher } = {}) {
  if (!transport || typeof transport.openPty !== "function") {
    throw new TypeError("createTerminalRelay: an SSH transport with openPty() is required");
  }
  if (!hosts || typeof hosts.find !== "function") {
    throw new TypeError("createTerminalRelay: a host store with find() is required");
  }
  const log = makeLogger(logger);
  const ttlMs = nonNegativeInt(config?.userTerminalTtlMs, DEFAULT_USER_TERMINAL_TTL_MS);
  const reconnectAttempts = nonNegativeInt(
    config?.userTerminalReconnectAttempts,
    DEFAULT_USER_TERMINAL_RECONNECT_ATTEMPTS,
  );
  const scrollbackBytes = positiveInt(config?.userTerminalScrollbackBytes, DEFAULT_USER_TERMINAL_SCROLLBACK_BYTES);
  // Resolve once (the Electron run-as-node probe is cached) so every shell line
  // for this relay uses the same launch strategy.
  const launch = resolveNodeLaunch(launcher);
  const resolvedSocketPath =
    typeof socketPath === "string" && socketPath.trim().length > 0
      ? process.platform === "win32" && socketPath.startsWith("\\\\.\\pipe\\")
        ? socketPath
        : path.resolve(socketPath.trim())
      : defaultRelaySocketPath();

  /** @type {Map<string, RelayEntry>} */
  const sessions = new Map();
  /** @type {Map<string, Promise<RelayEntry>>} in-flight opens, keyed by session key */
  const pendingOpens = new Map();
  let disposed = false;
  /** @type {Promise<void>|null} */
  let disposePromise = null;

  /* ------------------------------ socket server ---------------------------- */
  const bridgeServer = createBridgeServer({
    socketPath: resolvedSocketPath,
    logger: log,
    clearScreen: CLEAR_SCREEN_SEQUENCE,
    findSession(hostName, sessionId) {
      return sessions.get(sessionKeyFor(sessionId, hostName)) ?? null;
    },
    replayFor(entry) {
      return entry.chunks.join("");
    },
    onAttach(entry) {
      clearTimer(entry, "ttlTimer");
      entry.updatedAt = Date.now();
      entry.attachCount += 1;
      entry.lastAttachAt = entry.updatedAt;
      auditEvent("attach", entry, "ok", `${entry.sessionKey} (attached ${bridgeServer.attached(entry)})`);
    },
    onDetach(entry) {
      entry.updatedAt = Date.now();
      entry.lastDetachAt = entry.updatedAt;
      auditEvent("detach", entry, "ok", `${entry.sessionKey} (attached ${bridgeServer.attached(entry)})`);
      if (bridgeServer.attached(entry) === 0 && entry.state !== "closed" && entry.agentOwned !== true) scheduleTtl(entry);
    },
    onInput(entry, text) {
      if (!text) return;
      // Invalidate Agent proof before forwarding operator bytes. Never log input.
      entry.verifiedReady = false;
      entry.verifiedProof?.cancel();
      entry.bytesIn = Math.min(Number.MAX_SAFE_INTEGER, entry.bytesIn + Buffer.byteLength(text, "utf8"));
      if (!entry.pty) return;
      if (entry.state !== "connected") {
        // Only explicit human Ctrl-C may interrupt automatic initialization.
        // Never queue arbitrary bytes to execute later on the entrance host.
        if (entry.initializing && text.includes("\u0003")) {
          try { entry.pty.write("\u0003"); } catch { /* best effort */ }
          entry.humanCancelled = true;
          entry.abort?.abort();
        }
        return;
      }
      try {
        entry.pty.write(text);
      } catch (error) {
        log.debug(`[dsh-remote] terminal input write failed: ${messageOf(error)}`);
      }
    },
    onResize(entry, cols, rows) {
      applyResize(entry, cols, rows);
    },
  });

  /* ----------------------------- audit + stream ---------------------------- */
  /**
   * Record one lifecycle event; never throws into the caller.
   *
   * @param {"open"|"reconnect"|"close"|"attach"|"detach"} action
   * @param {RelayEntry} entry
   * @param {"ok"|"error"} [outcome]
   * @param {string} [detail]
   */
  function auditEvent(action, entry, outcome = "ok", detail) {
    if (typeof audit?.record !== "function") return;
    try {
      audit.record({
        tool: "terminal",
        host: entry.hostName,
        action,
        risk: "read",
        outcome,
        detail: detail ?? `${entry.sessionKey} (${entry.target})`,
      });
    } catch (error) {
      log.debug(`[dsh-remote] terminal audit failed: ${messageOf(error)}`);
    }
  }

  /** Trim the replay ring to its byte budget without splitting a UTF-8 sequence. */
  function trimReplay(entry) {
    if (entry.replayBytes <= scrollbackBytes) return;
    while (entry.chunks.length > 1 && entry.replayBytes > scrollbackBytes) {
      entry.replayBytes -= Buffer.byteLength(/** @type {string} */ (entry.chunks.shift()), "utf8");
    }
    if (entry.replayBytes > scrollbackBytes && entry.chunks.length === 1) {
      const tail = utf8Tail(entry.chunks[0], scrollbackBytes);
      entry.chunks[0] = tail.text;
      entry.replayBytes = Buffer.byteLength(tail.text, "utf8");
    }
  }

  /**
   * Append stream text (PTY output or a banner) to the replay ring and broadcast
   * it to every attached bridge. Never throws.
   *
   * @param {RelayEntry} entry
   * @param {string} text
   * @param {{ countBytes?: boolean }} [options]
   */
  function appendStream(entry, text, { countBytes = false } = {}) {
    if (!text) return;
    try {
      const bytes = Buffer.byteLength(text, "utf8");
      entry.chunks.push(text);
      entry.replayBytes += bytes;
      trimReplay(entry);
      if (countBytes) entry.bytesOut = Math.min(Number.MAX_SAFE_INTEGER, entry.bytesOut + bytes);
      entry.updatedAt = Date.now();
      bridgeServer.broadcast(entry, text);
    } catch (error) {
      log.warn(`[dsh-remote] terminal stream append failed: ${messageOf(error)}`);
    }
  }

  /* -------------------------------- timers --------------------------------- */
  /** @param {RelayEntry} entry @param {"ttlTimer"|"reconnectTimer"} key */
  function clearTimer(entry, key) {
    if (!entry[key]) return;
    clearTimeout(/** @type {NodeJS.Timeout} */ (entry[key]));
    entry[key] = null;
  }

  /** Arm the idle TTL after the last bridge detached (`0` disables it). */
  function scheduleTtl(entry) {
    clearTimer(entry, "ttlTimer");
    if (ttlMs <= 0 || disposed || entry.state === "closed" || entry.agentOwned === true) return;
    entry.ttlTimer = setTimeout(() => {
      entry.ttlTimer = null;
      if (entry.state === "closed" || disposed) return;
      log.debug(`[dsh-remote] terminal session ${entry.sessionKey} idle TTL expired`);
      void closeEntry(entry, "ttl").catch((error) => {
        log.warn(`[dsh-remote] terminal TTL close failed: ${messageOf(error)}`);
      });
    }, ttlMs);
  }

  /* ------------------------------ PTY ownership ---------------------------- */
  /** Open one PTY with an abort controller so close/dispose settle attempts. */
  async function openPtyFor(entry) {
    const controller = new AbortController();
    entry.abort = controller;
    try {
      return await transport.openPty(entry.host, {
        cols: entry.cols,
        rows: entry.rows,
        term: RELAY_PTY_TERM,
        signal: controller.signal,
      });
    } finally {
      if (entry.abort === controller) entry.abort = null;
    }
  }

  function auditLogin(entry, detail) {
    try {
      audit?.record?.({ tool: "terminal.login", host: entry.hostName, action: "execute", risk: "gray", outcome: "ok", detail });
    } catch (error) { log.debug(`[dsh-remote] login audit failed: ${messageOf(error)}`); }
  }

  /** Open and initialize each new channel before it can be used as the cluster. */
  async function connectEntry(entry) {
    entry.initializing = true;
    entry.humanCancelled = false;
    entry.actionProgress = null;
    try {
      // Every new channel gets fresh coordinates and fresh entrance policy.
      const host = await hosts.find(entry.hostName);
      if (!host || (typeof hosts.isAllowed === "function" && !hosts.isAllowed(host))) {
        throw codedError(`terminal relay: host ${JSON.stringify(entry.hostName)} is not allowed by allowHosts`, "HOST_DISALLOWED");
      }
      entry.host = host;
      entry.target = targetLabel(host);
      const profile = await authorizeConnectionLogin(host, { config, hosts, logger: log });
      if (disposed || entry.state === "closed") throw codedError("Terminal open cancelled", "TERMINAL_CANCELLED");
      const channelConnectionDigest = targetConnectionDigest(host);
      const pty = await openPtyFor(entry);
      entry.connectionDigest = channelConnectionDigest;
      if (disposed || entry.state === "closed") {
        await pty.close("relay disposed").catch(() => {});
        throw codedError("terminal relay has been disposed", "TERMINAL_ERROR");
      }
      wirePty(entry, pty);
      if (profile) {
        const controller = new AbortController();
        entry.abort = controller;
        entry.loginState = "waiting";
        try {
          await runConnectionLogin(pty, {
            profile, initialOutput: entry.latestPtyOutput, signal: controller.signal,
            timeoutMs: positiveInt(config?.connectTimeoutMs, 20_000),
            onCommand() {
              entry.loginState = "sent";
              // Custom actions may include sensitive text. Never log their bytes.
              auditLogin(entry, "command action submitted");
            },
            onProgress(progress) {
              entry.actionProgress = { ...progress };
              entry.updatedAt = Date.now();
              if (progress.state === "running") {
                entry.loginState = "sent";
                appendStream(entry, `\r\n[dsh-remote] ${entry.hostName}: action ${progress.index + 1}/${progress.total} (${progress.type ?? "wait"})\r\n`);
              }
            },
          });
          if (controller.signal.aborted || entry.humanCancelled || entry.state === "closed") {
            throw codedError("Connection login cancelled", "LOGIN_CANCELLED");
          }
          entry.loginState = "confirmed";
          auditLogin(entry, "all connection actions completed");
        } catch (error) {
          entry.loginState = "failed";
          auditEvent("open", entry, "error", `cluster login failed: ${messageOf(error)}`);
          const failedPty = detachPty(entry);
          await failedPty?.close("login-failed").catch(() => {});
          throw error;
        } finally {
          if (entry.abort === controller) entry.abort = null;
        }
      }
      if (pty.status?.().kind === "exited") throw codedError("SSH PTY exited during initialization", "LOGIN_EXIT");
      return pty;
    } finally {
      entry.initializing = false;
    }
  }

  /** Wire one PTY handle into the entry; listeners never throw out. */
  function wirePty(entry, pty) {
    entry.pty = pty;
    entry.latestPtyOutput = "";
    entry.detachData = pty.onData((text) => {
      try {
        entry.latestPtyOutput = utf8Tail(entry.latestPtyOutput + text, 32_768).text;
        appendStream(entry, text, { countBytes: true });
      } catch (error) {
        log.debug(`[dsh-remote] terminal output handler failed: ${messageOf(error)}`);
      }
    });
    entry.detachExit = pty.onExit(() => {
      try {
        handlePtyExit(entry, pty);
      } catch (error) {
        log.warn(`[dsh-remote] terminal exit handler failed: ${messageOf(error)}`);
      }
    });
  }

  /** Detach the current PTY listeners and return the handle. */
  function detachPty(entry) {
    const pty = entry.pty;
    entry.pty = null;
    try {
      entry.detachData?.();
    } catch {
      // ignore
    }
    try {
      entry.detachExit?.();
    } catch {
      // ignore
    }
    entry.detachData = null;
    entry.detachExit = null;
    return pty;
  }

  /** Apply a validated window size to the entry and (when live) the PTY. */
  function applyResize(entry, cols, rows) {
    const width = positiveInt(cols, 0);
    const height = positiveInt(rows, 0);
    if (!width || !height) return;
    entry.cols = width;
    entry.rows = height;
    entry.updatedAt = Date.now();
    if (entry.pty && entry.state === "connected") {
      try {
        entry.pty.resize(width, height);
      } catch (error) {
        log.debug(`[dsh-remote] terminal resize failed: ${messageOf(error)}`);
      }
    }
  }

  /* -------------------------------- reconnect ------------------------------ */
  /** Unexpected PTY exit: keep bridges attached, banner, start backoff. */
  function handlePtyExit(entry, pty) {
    if (entry.state === "closed" || disposed || entry.pty !== pty) return;
    detachPty(entry);
    entry.updatedAt = Date.now();
    // Initialization owns its failure and retry accounting. An exit here must
    // not reset the retry counter or schedule a concurrent reconnect.
    if (entry.initializing) return;
    if (entry.agentOwned === true) {
      entry.state = "error";
      entry.lastError = "The shared Agent PTY exited; it was not reconnected to a fresh shell.";
      appendStream(entry, "\r\n\u001b[33m[dsh-remote] Agent 共享终端已结束；为避免伪装为原会话，不会自动重连新 shell。\u001b[0m\r\n");
      log.info(`[dsh-remote] shared Agent terminal ${entry.sessionKey} exited; automatic reconnect is disabled`);
      return;
    }
    entry.state = "reconnecting";
    entry.reconnectAttempt = 0;
    appendStream(entry, BANNER_RECONNECTING);
    log.info(`[dsh-remote] terminal session ${entry.sessionKey} lost its SSH channel; reconnecting`);
    scheduleReconnect(entry);
  }

  /** Schedule the next reconnect attempt with 1/2/4/8/16/30 s backoff. */
  function scheduleReconnect(entry) {
    if (disposed || entry.state === "closed" || entry.state === "error") return;
    if (reconnectAttempts <= 0) return failReconnect(entry, "reconnect attempts disabled");
    if (entry.reconnectAttempt >= reconnectAttempts) {
      return failReconnect(entry, `reconnect attempts exhausted after ${entry.reconnectAttempt}`);
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(entry.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    clearTimer(entry, "reconnectTimer");
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (disposed || entry.state !== "reconnecting") return;
      void attemptReconnect(entry).catch((error) => {
        log.warn(`[dsh-remote] terminal reconnect failed: ${messageOf(error)}`);
      });
    }, delay);
  }

  /** One reconnect attempt: reopen the PTY or schedule/fail. */
  async function attemptReconnect(entry) {
    if (disposed || entry.state !== "reconnecting") return;
    entry.reconnectAttempt += 1;
    entry.updatedAt = Date.now();
    try {
      await connectEntry(entry);
      if (disposed || entry.state === "closed") return;
      entry.state = "connected";
      entry.reconnectAttempt = 0;
      entry.lastError = null;
      entry.updatedAt = Date.now();
      appendStream(entry, BANNER_RESTORED);
      auditEvent("reconnect", entry, "ok", `${entry.sessionKey} reconnected (${entry.target})`);
      log.info(`[dsh-remote] terminal session ${entry.sessionKey} reconnected`);
    } catch (error) {
      const message = messageOf(error);
      entry.lastError = message;
      entry.updatedAt = Date.now();
      log.warn(`[dsh-remote] terminal reconnect attempt ${entry.reconnectAttempt} failed: ${message}`);
      auditEvent(
        "reconnect",
        entry,
        "error",
        `${entry.sessionKey} attempt ${entry.reconnectAttempt}/${reconnectAttempts} failed: ${message}`,
      );
      if (entry.humanCancelled || entry.reconnectAttempt >= reconnectAttempts) failReconnect(entry, message);
      else scheduleReconnect(entry);
    }
  }

  /** Give up: end in `error` with a final banner. */
  function failReconnect(entry, reason) {
    if (entry.state === "closed") return;
    clearTimer(entry, "reconnectTimer");
    entry.state = "error";
    entry.lastError = reason;
    entry.updatedAt = Date.now();
    appendStream(entry, BANNER_EXHAUSTED);
    log.warn(`[dsh-remote] terminal session ${entry.sessionKey} gave up reconnecting: ${reason}`);
  }

  /* -------------------------------- sessions ------------------------------- */
  /** @returns {RelayEntry} */
  function makeEntry(host, requestedName, sessionId, cols, rows) {
    const hostName = typeof host?.name === "string" && host.name ? host.name : requestedName;
    const now = Date.now();
    return {
      sessionKey: sessionKeyFor(sessionId, hostName),
      host,
      hostName,
      target: targetLabel(host),
      sessionId,
      state: "connecting",
      pty: null,
      reconnectAttempt: 0,
      cols,
      rows,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      bytesOut: 0,
      bytesIn: 0,
      attachCount: 0,
      lastAttachAt: null,
      lastDetachAt: null,
      agentOwned: false,
      chunks: [],
      replayBytes: 0,
      ready: null,
      abort: null,
      ttlTimer: null,
      reconnectTimer: null,
      detachData: null,
      detachExit: null,
    };
  }

  /** @returns {TerminalSessionView} */
  function snapshot(entry) {
    return {
      sessionKey: entry.sessionKey,
      host: entry.hostName,
      target: entry.target,
      sessionId: entry.sessionId,
      state: entry.state,
      attached: bridgeServer.attached(entry),
      reconnectAttempt: entry.reconnectAttempt,
      cols: entry.cols,
      rows: entry.rows,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastError: entry.lastError,
      bytesOut: entry.bytesOut,
      bytesIn: entry.bytesIn,
      attachCount: entry.attachCount,
      lastAttachAt: entry.lastAttachAt,
      lastDetachAt: entry.lastDetachAt,
      sharedWithAgent: entry.agentOwned === true,
      ...(entry.host.viaHost ? { viaHost: entry.host.viaHost, actionCount: entry.actionProgress?.total ?? entry.host.actions?.length ?? 0,
        actionProgress: entry.actionProgress ? { ...entry.actionProgress } : null, loginState: entry.loginState ?? "waiting" } : {}),
    };
  }

  /** Close one entry from any state: timers, PTY, bridges, audit. Idempotent. */
  async function closeEntry(entry, reason) {
    if (entry.state === "closed") return;
    entry.state = "closed";
    entry.updatedAt = Date.now();
    if (sessions.get(entry.sessionKey) === entry) sessions.delete(entry.sessionKey);
    clearTimer(entry, "ttlTimer");
    clearTimer(entry, "reconnectTimer");
    try {
      entry.abort?.abort();
    } catch {
      // ignore
    }
    entry.abort = null;
    const pty = detachPty(entry);
    appendStream(entry, BANNER_CLOSED);
    bridgeServer.endEntry(entry);
    if (pty) {
      try {
        await pty.close(reason);
      } catch (error) {
        log.debug(`[dsh-remote] terminal PTY close failed: ${messageOf(error)}`);
      }
    }
    auditEvent("close", entry, "ok", `${entry.sessionKey} (${reason})`);
  }

  /** @returns {{ command: string, sessionKey: string, socketPath: string, host: { name: string, target: string } }} */
  function shellFor(entry) {
    return {
      command: buildBridgeCommand({
        host: entry.hostName,
        session: entry.sessionId,
        socket: resolvedSocketPath,
        launch,
      }),
      sessionKey: entry.sessionKey,
      socketPath: resolvedSocketPath,
      host: { name: entry.hostName, target: entry.target, ...(entry.host.viaHost ? { viaHost: entry.host.viaHost,
        actionCount: entry.actionProgress?.total ?? entry.host.actions?.length ?? 0,
        actionProgress: entry.actionProgress ? { ...entry.actionProgress } : null, loginState: entry.loginState ?? "waiting" } : {}) },
    };
  }

  /** Compute the session key used for reuse. */
  function sessionKeyFor(sessionId, hostName) {
    return `${normalizeSessionId(sessionId)}::${String(hostName ?? "").trim()}`;
  }
  /* -------------------------------- public API ----------------------------- */
  /** Start the socket server (idempotent). */
  function start() {
    if (disposed) return Promise.reject(codedError("terminal relay has been disposed", "TERMINAL_ERROR"));
    return bridgeServer.start();
  }

  /**
   * One SSH PTY per `(sessionId, hostName)`, reused while it is live.
   *
   * @param {{ hostName: string, sessionId?: string, cols?: number, rows?: number, preserveSize?: boolean, signal?: AbortSignal }} options
   */
  async function open(options = {}) {
    if (disposed) throw codedError("terminal relay has been disposed", "TERMINAL_ERROR");
    const hostName = typeof options.hostName === "string" ? options.hostName.trim() : "";
    if (!hostName) throw codedError("terminal relay: a non-empty hostName is required", "TERMINAL_ERROR");
    const sessionId = normalizeSessionId(options.sessionId);
    const cols = positiveInt(options.cols, DEFAULT_COLS);
    const rows = positiveInt(options.rows, DEFAULT_ROWS);
    const preserveSize = options.preserveSize === true;
    const signal = options.signal;
    checkRequest(signal);
    await waitForRequest(start(), signal);
    if (bridgeServer.isExternal) {
      throw codedError(
        `terminal relay socket ${JSON.stringify(resolvedSocketPath)} is served by another dsh-remote instance`,
        "TERMINAL_ERROR",
      );
    }

    const host = await waitForRequest(hosts.find(hostName), signal);
    checkRequest(signal);
    if (typeof hosts.isAllowed === "function" && !hosts.isAllowed(host)) {
      throw codedError(`terminal relay: host ${JSON.stringify(hostName)} is not allowed by allowHosts`, "HOST_DISALLOWED");
    }
    const displayName = typeof host?.name === "string" && host.name ? host.name : hostName;
    const sessionKey = sessionKeyFor(sessionId, displayName);

    const existing = sessions.get(sessionKey);
    if (existing && existing.state !== "closed" && existing.state !== "error") {
      applyResize(existing, preserveSize ? existing.cols : cols, preserveSize ? existing.rows : rows);
      try {
        await waitForRequest(existing.ready, signal);
      } catch {
        checkRequest(signal); // A cancelled reuser must never replace/close the owner's entry.
        // Initial connect failed; fall through and report/replace below.
      }
      checkRequest(signal);
      if (existing.state !== "closed" && existing.state !== "error") {
        return { shell: shellFor(existing), session: snapshot(existing), reused: true };
      }
    }
    if (existing) await closeEntry(existing, "replace");
    if (pendingOpens.has(sessionKey)) {
      // A failed in-flight open settles to a closed entry; retry below.
      const fresh = await waitForRequest(pendingOpens.get(sessionKey), signal);
      checkRequest(signal);
      if (fresh && fresh.state !== "closed" && sessions.get(sessionKey) === fresh) {
        return { shell: shellFor(fresh), session: snapshot(fresh), reused: true };
      }
    }

    checkRequest(signal);
    const entry = makeEntry(host, displayName, sessionId, cols, rows);
    sessions.set(sessionKey, entry);
    const cancelOwnedOpen = () => { void closeEntry(entry, "open-cancelled").catch(() => {}); };
    signal?.addEventListener("abort", cancelOwnedOpen, { once: true });
    if (signal?.aborted) cancelOwnedOpen();
    entry.ready = (async () => {
      await connectEntry(entry);
      if (disposed || entry.state === "closed") throw codedError("terminal relay has been disposed", "TERMINAL_ERROR");
      entry.state = "connected";
      entry.updatedAt = Date.now();
      auditEvent("open", entry, "ok", `${entry.sessionKey} (${entry.target})`);
    })();
    // Settle to the entry (never reject): open failures are reported by the
    // `await entry.ready` below and must not become unhandled rejections.
    const settleToEntry = () => entry;
    const settledOpen = entry.ready.then(settleToEntry, settleToEntry);
    pendingOpens.set(sessionKey, settledOpen);
    try {
      await waitForRequest(entry.ready, signal);
      checkRequest(signal);
    } catch (error) {
      await closeEntry(entry, "open-failed").catch(() => {});
      const authFailed = error?.code === "AUTH";
      const detail = authFailed ? "SSH authentication failed" : messageOf(error);
      auditEvent("open", entry, "error", `${entry.sessionKey} failed: ${detail}`);
      throw codedError(`terminal relay could not open a PTY for ${entry.target}: ${detail}`, authFailed ? "AUTH" : "TERMINAL_ERROR");
    } finally {
      signal?.removeEventListener("abort", cancelOwnedOpen);
      // A newer explicit open may already have replaced the cancelled entry.
      if (pendingOpens.get(sessionKey) === settledOpen) pendingOpens.delete(sessionKey);
      entry.ready = null;
    }
    return { shell: shellFor(entry), session: snapshot(entry), reused: false };
  }

  /**
   * Acquire the canonical relay PTY for an Agent's persistent shell. The relay
   * still owns reconnect/bridge bookkeeping, but this session no longer expires
   * when the user closes the native terminal. Agent disposal/close calls the
   * returned PTY's close method, which closes this exact relay entry.
   *
   * @param {{ hostName: string, sessionId: string, cols?: number, rows?: number, signal?: AbortSignal }} options
   * @returns {Promise<{ pty: object, initialOutput: string, session: TerminalSessionView, reused: boolean }>}
   */
  async function acquireAgentPty(options = {}) {
    const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
    if (!sessionId) throw codedError("terminal relay: Agent sessionId is required", "INVALID_SESSION");
    const opened = await open({ ...options, preserveSize: true });
    const entry = sessions.get(opened.session.sessionKey);
    if (options.signal?.aborted) {
      if (entry && !opened.reused) await closeEntry(entry, "open-cancelled");
      checkRequest(options.signal);
    }
    if (!entry || entry.state !== "connected" || !entry.pty) {
      throw codedError(
        `shared terminal ${opened.session.sessionKey} is not connected; refusing to attach the Agent to a replacement shell`,
        "SHARED_PTY_UNAVAILABLE",
      );
    }
    entry.agentOwners = (entry.agentOwners ?? 0) + 1;
    entry.agentOwned = true;
    clearTimer(entry, "ttlTimer");
    const raw = entry.pty;
    let dataListener = null;
    let exitListener = null;
    let pendingExit = null;
    const pendingData = [];
    let detached = false;
    const detachData = raw.onData((text) => {
      if (dataListener) dataListener(text);
      else pendingData.push(text);
    });
    const detachExit = raw.onExit((info) => {
      if (exitListener) exitListener(info);
      else pendingExit = info;
    });
    const rawStatus = raw.status?.();
    if (rawStatus?.kind === "exited" && pendingExit === null) {
      pendingExit = { code: rawStatus.exitCode ?? null, signal: rawStatus.signal ?? null };
    }
    const detachHandoff = () => {
      if (detached) return;
      detached = true;
      dataListener = null;
      exitListener = null;
      pendingData.length = 0;
      try { detachData?.(); } catch { /* best effort */ }
      try { detachExit?.(); } catch { /* best effort */ }
    };
    let released = false;
    const pty = {
      connectionDigest: entry.connectionDigest,
      // Failed adoption releases listeners/ownership, not an existing human PTY.
      release() {
        if (released) return;
        released = true;
        // Disable this borrowed handle before cancellation callbacks can signal
        // or write into the human-owned foreground process.
        if (!entry.verifiedProof) entry.verifiedReady = false;
        if (entry.verifiedProof?.owner === pty) {
          const proof = entry.verifiedProof;
          entry.verifiedProof = null;
          entry.verifiedReady = false;
          proof.detachExit?.();
          proof.cancel();
        }
        detachHandoff();
        entry.agentOwners = Math.max(0, (entry.agentOwners ?? 1) - 1);
        entry.agentOwned = entry.agentOwners > 0;
        if (!entry.agentOwned && bridgeServer.attached(entry) === 0) scheduleTtl(entry);
      },
      beginVerifiedLease(cancel) {
        if (entry.verifiedProof) throw codedError('Shared PTY already has a verified lease', 'VERIFIED_LEASE_BUSY');
        if (released || detached || entry.pty !== raw || entry.state !== 'connected') throw codedError('Shared PTY channel is no longer current', 'VERIFIED_LEASE_INVALID');
        const proof = { cancel, owner: pty };
        entry.verifiedProof = proof;
        const detachProofExit = raw.onExit(() => { entry.verifiedReady = false; cancel(); });
        proof.detachExit = detachProofExit;
        return { valid: () => entry.verifiedProof === proof && entry.pty === raw && entry.state === 'connected' && !released && !detached,
          ready: () => entry.verifiedReady === raw,
          setReady(value) { if (entry.verifiedProof === proof) entry.verifiedReady = value ? raw : false; },
          release() { detachProofExit?.(); if (entry.verifiedProof === proof) entry.verifiedProof = null; } };
      },
      write(text) {
        if (released || detached) throw codedError('Agent shell handle was released; shared terminal was not closed', 'SESSION_RELEASED');
        if (entry.verifiedProof?.owner !== pty) { entry.verifiedReady = false; entry.verifiedProof?.cancel(); }
        return raw.write(text);
      },
      resize(width, height) { if (!released && !detached) return raw.resize(width, height); },
      signal(name) {
        if (released || detached) return false;
        entry.verifiedReady = false; entry.verifiedProof?.cancel(); return raw.signal(name);
      },
      onData(listener) {
        dataListener = listener;
        for (const text of pendingData.splice(0)) listener(text);
        return () => {
          if (dataListener === listener) dataListener = null;
          if (exitListener === null) detachHandoff();
        };
      },
      onExit(listener) {
        exitListener = listener;
        if (pendingExit !== null) listener(pendingExit);
        return () => {
          if (exitListener === listener) exitListener = null;
          if (dataListener === null) detachHandoff();
        };
      },
      status() { return raw.status(); },
      async close(reason) {
        detachHandoff();
        if (!released) return closeEntry(entry, reason || "Agent shell closed");
      },
    };
    return { pty, initialOutput: entry.chunks.join(""), session: snapshot(entry), reused: opened.reused };
  }

  /** Snapshot every session, optionally filtered to one conversation. */
  function list({ sessionId } = {}) {
    const filter = sessionId === undefined || sessionId === null ? null : normalizeSessionId(sessionId);
    return [...sessions.values()]
      .filter((entry) => entry.state !== "closed")
      .filter((entry) => filter === null || entry.sessionId === filter)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((entry) => snapshot(entry));
  }

  /** Close one session by key; false for an unknown/closed key. */
  async function close(sessionKey) {
    if (typeof sessionKey !== "string" || !sessionKey) return false;
    const entry = sessions.get(sessionKey);
    if (!entry) return false;
    await closeEntry(entry, "close");
    return true;
  }

  /** Close the server and every session (quiescent, idempotent). */
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      await bridgeServer.dispose();
      await Promise.allSettled([...sessions.values()].map((entry) => closeEntry(entry, "dispose")));
      sessions.clear();
      pendingOpens.clear();
    })().catch((error) => {
      log.warn(`[dsh-remote] terminal relay dispose failed: ${messageOf(error)}`);
    });
    return /** @type {Promise<void>} */ (disposePromise);
  }

  return {
    start,
    open,
    acquireAgentPty,
    list,
    close,
    dispose,
    sessionKeyFor,
    socketPath: resolvedSocketPath,
    get size() {
      return sessions.size;
    },
    get isDisposed() {
      return disposed;
    },
    get isStarted() {
      return bridgeServer.isStarted;
    },
  };
}
