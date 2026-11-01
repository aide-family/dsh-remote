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
import { fileURLToPath } from "node:url";

import { utf8Tail } from "./scrollback.js";
import { createBridgeServer, defaultRelaySocketPath } from "./relay-socket.js";

export { defaultRelaySocketPath, resolveHarnessHome } from "./relay-socket.js";

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
 * @property {string[]} chunks
 * @property {number} replayBytes
 * @property {Promise<void>|null} ready
 * @property {AbortController|null} abort
 * @property {NodeJS.Timeout|null} ttlTimer
 * @property {NodeJS.Timeout|null} reconnectTimer
 * @property {(() => void)|null} detachData
 * @property {(() => void)|null} detachExit
 */

/** Defensive logger wrapper: logging must never break the relay. */
function makeLogger(logger) {
  const source = logger && typeof logger === "object" ? logger : {};
  /** @type {Record<string, Function>} */
  const log = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    log[level] = (...args) => {
      try {
        source[level]?.apply(source, args);
      } catch {
        // ignore
      }
    };
  }
  return log;
}
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
/**
 * POSIX single-quote a value for `/bin/sh` / zsh.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
/** @param {unknown} value @returns {string} */
function normalizeSessionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : DEFAULT_SESSION_ID;
}
/** Absolute path of the packaged launcher the native terminal types. */
export function defaultLauncherPath() {
  return fileURLToPath(new URL("../../bin/dsh-remote-terminal", import.meta.url));
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
 */
export function createTerminalRelay({ transport, hosts, config, audit, logger, socketPath } = {}) {
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
  const launcherPath = defaultLauncherPath();
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
    },
    onDetach(entry) {
      entry.updatedAt = Date.now();
      if (bridgeServer.attached(entry) === 0 && entry.state !== "closed") scheduleTtl(entry);
    },
    onInput(entry, text) {
      if (!entry.pty || entry.state !== "connected") return;
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
   * @param {"open"|"reconnect"|"close"} action
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
    if (ttlMs <= 0 || disposed || entry.state === "closed") return;
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

  /** Wire one PTY handle into the entry; listeners never throw out. */
  function wirePty(entry, pty) {
    entry.pty = pty;
    entry.detachData = pty.onData((text) => {
      try {
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
    entry.state = "reconnecting";
    entry.reconnectAttempt = 0;
    entry.updatedAt = Date.now();
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
      const pty = await openPtyFor(entry);
      if (disposed || entry.state === "closed") {
        await pty.close("relay disposed").catch(() => {});
        return;
      }
      wirePty(entry, pty);
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
      if (entry.reconnectAttempt >= reconnectAttempts) failReconnect(entry, message);
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

  /** The exact shell line the browser types into the native terminal. */
  function buildCommand(entry) {
    return [
      "exec",
      shellQuote(launcherPath),
      "--host",
      shellQuote(entry.hostName),
      "--session",
      shellQuote(entry.sessionId),
      "--socket",
      shellQuote(resolvedSocketPath),
    ].join(" ");
  }

  /** @returns {{ command: string, sessionKey: string, socketPath: string, host: { name: string, target: string } }} */
  function shellFor(entry) {
    return {
      command: buildCommand(entry),
      sessionKey: entry.sessionKey,
      socketPath: resolvedSocketPath,
      host: { name: entry.hostName, target: entry.target },
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
   * @param {{ hostName: string, sessionId?: string, cols?: number, rows?: number }} options
   */
  async function open(options = {}) {
    if (disposed) throw codedError("terminal relay has been disposed", "TERMINAL_ERROR");
    const hostName = typeof options.hostName === "string" ? options.hostName.trim() : "";
    if (!hostName) throw codedError("terminal relay: a non-empty hostName is required", "TERMINAL_ERROR");
    const sessionId = normalizeSessionId(options.sessionId);
    const cols = positiveInt(options.cols, DEFAULT_COLS);
    const rows = positiveInt(options.rows, DEFAULT_ROWS);
    await start();
    if (bridgeServer.isExternal) {
      throw codedError(
        `terminal relay socket ${JSON.stringify(resolvedSocketPath)} is served by another dsh-remote instance`,
        "TERMINAL_ERROR",
      );
    }

    const host = await hosts.find(hostName);
    if (typeof hosts.isAllowed === "function" && !hosts.isAllowed(host)) {
      throw codedError(`terminal relay: host ${JSON.stringify(hostName)} is not allowed by allowHosts`, "HOST_DISALLOWED");
    }
    const displayName = typeof host?.name === "string" && host.name ? host.name : hostName;
    const sessionKey = sessionKeyFor(sessionId, displayName);

    const existing = sessions.get(sessionKey);
    if (existing && existing.state !== "closed" && existing.state !== "error") {
      applyResize(existing, cols, rows);
      try {
        await existing.ready;
      } catch {
        // Initial connect failed; fall through and report/replace below.
      }
      if (existing.state !== "closed" && existing.state !== "error") {
        return { shell: shellFor(existing), session: snapshot(existing) };
      }
    }
    if (existing) await closeEntry(existing, "replace");
    if (pendingOpens.has(sessionKey)) {
      // A failed in-flight open settles to a closed entry; retry below.
      const fresh = await pendingOpens.get(sessionKey);
      if (fresh && fresh.state !== "closed" && sessions.get(sessionKey) === fresh) {
        return { shell: shellFor(fresh), session: snapshot(fresh) };
      }
    }

    const entry = makeEntry(host, displayName, sessionId, cols, rows);
    sessions.set(sessionKey, entry);
    entry.ready = (async () => {
      const pty = await openPtyFor(entry);
      if (disposed || entry.state === "closed") {
        await pty.close("relay disposed").catch(() => {});
        throw codedError("terminal relay has been disposed", "TERMINAL_ERROR");
      }
      wirePty(entry, pty);
      entry.state = "connected";
      entry.updatedAt = Date.now();
      auditEvent("open", entry, "ok", `${entry.sessionKey} (${entry.target})`);
    })();
    // Settle to the entry (never reject): open failures are reported by the
    // `await entry.ready` below and must not become unhandled rejections.
    const settleToEntry = () => entry;
    pendingOpens.set(sessionKey, entry.ready.then(settleToEntry, settleToEntry));
    try {
      await entry.ready;
    } catch (error) {
      await closeEntry(entry, "open-failed").catch(() => {});
      auditEvent("open", entry, "error", `${entry.sessionKey} failed: ${messageOf(error)}`);
      throw codedError(`terminal relay could not open a PTY for ${entry.target}: ${messageOf(error)}`, "TERMINAL_ERROR");
    } finally {
      pendingOpens.delete(sessionKey);
      entry.ready = null;
    }
    return { shell: shellFor(entry), session: snapshot(entry) };
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
