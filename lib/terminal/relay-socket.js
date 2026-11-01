/**
 * Local socket server for the interactive SSH terminal relay (v0.5).
 *
 * `lib/terminal/relay.js` owns the SSH PTYs and the session state; this module
 * owns the Unix-socket (or Windows named-pipe) transport that connects them to
 * the bridge process (`lib/terminal/bridge.cjs`) running inside DSH's native
 * terminal:
 *
 * - listen on `socketPath` with a 0700 parent dir and a 0600 socket; unlink a
 *   stale socket file after verifying it really is a socket;
 * - accept one JSON-line handshake `{"v":1,"host":"<name>","sessionId":"<id>"}`
 *   (10 s timeout), attach the connection to a session via injected callbacks,
 *   then send the screen clear + bounded replay tail;
 * - forward newline-delimited bridge frames
 *   `{"t":"i","d":"<base64>"}` (input), `{"t":"r","c":<cols>,"r":<rows>}`
 *   (resize) and `{"t":"c"}` (detach request); malformed frames are ignored;
 * - broadcast relay output to every attached bridge and end them all when the
 *   session closes; malformed/misbehaving clients can never throw into the
 *   relay.
 *
 * Every handler is defensive: this runs on the DSH Host process event loop.
 */

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** How long a new socket may take to send its handshake line. */
export const SOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_LINE_CHARS = 64 * 1024;

/**
 * One attached bridge connection.
 *
 * @typedef {object} BridgeRecord
 * @property {import("node:net").Socket} socket
 * @property {any} entry
 * @property {string} buffer
 * @property {boolean} handshakeDone
 * @property {boolean} closed
 * @property {NodeJS.Timeout|null} handshakeTimer
 */

/**
 * Defensive logger wrapper shared with `relay.js`: logging never throws.
 *
 * @param {unknown} logger
 */
export function makeLogger(logger) {
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

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the harness home exactly like the rest of the plugin.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveHarnessHome(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return configured.length > 0 ? configured : path.join(home, ".dsh");
}

/**
 * Default relay socket path: `$DSH_HOME/remote/terminal.sock` on POSIX, a
 * deterministic named pipe on Windows (sha1 of the harness home).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function defaultRelaySocketPath(env = process.env, home = homedir(), platform = process.platform) {
  const dshHome = resolveHarnessHome(env, home);
  if (platform === "win32") {
    return `\\\\.\\pipe\\dsh-remote-terminal-${createHash("sha1").update(dshHome).digest("hex")}`;
  }
  return path.join(dshHome, "remote", "terminal.sock");
}

/**
 * @typedef {object} BridgeServerOptions
 * @property {string} socketPath absolute POSIX socket path or Windows pipe path
 * @property {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [logger]
 * @property {string} [clearScreen] sequence prefixed to every attach (replay first paint)
 * @property {(hostName: string, sessionId: string) => any} findSession resolve an attached session or null
 * @property {(entry: any) => string} replayFor bounded replay text for one session
 * @property {(entry: any) => void} [onAttach] a bridge attached (cancel idle TTL)
 * @property {(entry: any) => void} [onDetach] the last action of one bridge detach (arm idle TTL)
 * @property {(entry: any, text: string) => void} [onInput] decoded user input for a session
 * @property {(entry: any, cols: number, rows: number) => void} [onResize] requested window size
 */

/**
 * Create the relay's local socket server.
 *
 * @param {BridgeServerOptions} options
 * @returns {{
 *   start(): Promise<void>,
 *   dispose(): Promise<void>,
 *   attached(entry: any): number,
 *   broadcast(entry: any, text: string): void,
 *   endEntry(entry: any): void,
 *   readonly socketPath: string,
 *   readonly isStarted: boolean,
 *   readonly isExternal: boolean,
 * }}
 */
export function createBridgeServer({
  socketPath,
  logger,
  clearScreen = "",
  findSession,
  replayFor,
  onAttach,
  onDetach,
  onInput,
  onResize,
} = {}) {
  if (typeof socketPath !== "string" || !socketPath) {
    throw new TypeError("createBridgeServer: a socketPath is required");
  }
  if (typeof findSession !== "function" || typeof replayFor !== "function") {
    throw new TypeError("createBridgeServer: findSession() and replayFor() are required");
  }
  const log = makeLogger(logger);
  /** @type {Set<BridgeRecord>} */
  const records = new Set();
  /** @type {Map<any, Set<BridgeRecord>>} */
  const byEntry = new Map();
  /** @type {net.Server|null} */
  let server = null;
  /** @type {Promise<void>|null} */
  let startPromise = null;
  /** @type {Promise<void>|null} */
  let disposePromise = null;
  let disposed = false;
  /** True when another relay instance already owns the live socket path. */
  let external = false;
  let ownsSocketFile = false;

  /** @param {BridgeRecord} record */
  function writeToBridge(record, text) {
    try {
      if (record.socket.writable) record.socket.write(text);
    } catch (error) {
      log.debug(`[dsh-remote] terminal bridge write failed: ${messageOf(error)}`);
    }
  }

  /** Remove one bridge (idempotent), notifying the relay for TTL bookkeeping. */
  function detach(record) {
    if (record.closed) return;
    record.closed = true;
    if (record.handshakeTimer) {
      clearTimeout(record.handshakeTimer);
      record.handshakeTimer = null;
    }
    records.delete(record);
    const entry = record.entry;
    record.entry = null;
    if (entry === null || entry === undefined) return;
    const set = byEntry.get(entry);
    if (set && set.delete(record) && set.size === 0) byEntry.delete(entry);
    try {
      onDetach?.(entry);
    } catch (error) {
      log.warn(`[dsh-remote] terminal detach handler failed: ${messageOf(error)}`);
    }
  }

  /** @param {BridgeRecord} record */
  function destroy(record) {
    try {
      record.socket.destroy();
    } catch {
      // ignore
    }
    detach(record);
  }

  /** Parse the single handshake line and attach the connection to a session. */
  function handleHandshake(record, line) {
    /** @type {any} */
    let handshake;
    try {
      handshake = JSON.parse(line);
    } catch {
      destroy(record);
      return false;
    }
    if (!handshake || typeof handshake !== "object") return destroy(record), false;
    const hostName = typeof handshake.host === "string" ? handshake.host.trim() : "";
    if (!hostName) return destroy(record), false;
    const sessionId = typeof handshake.sessionId === "string" ? handshake.sessionId : "";
    let entry = null;
    try {
      entry = findSession(hostName, sessionId);
    } catch (error) {
      log.warn(`[dsh-remote] terminal bridge session lookup failed: ${messageOf(error)}`);
    }
    if (!entry) {
      try {
        record.socket.end("\x1b[31m[dsh-remote] 终端会话不存在或已关闭。\x1b[0m\r\n");
      } catch {
        // ignore
      }
      detach(record);
      return false;
    }
    if (record.handshakeTimer) {
      clearTimeout(record.handshakeTimer);
      record.handshakeTimer = null;
    }
    record.handshakeDone = true;
    record.entry = entry;
    record.buffer = "";
    let set = byEntry.get(entry);
    if (!set) byEntry.set(entry, (set = new Set()));
    set.add(record);
    try {
      onAttach?.(entry);
    } catch (error) {
      log.warn(`[dsh-remote] terminal attach handler failed: ${messageOf(error)}`);
    }
    try {
      writeToBridge(record, clearScreen + replayFor(entry));
    } catch (error) {
      log.warn(`[dsh-remote] terminal replay write failed: ${messageOf(error)}`);
    }
    return true;
  }

  /** Apply one newline-delimited frame; malformed frames are ignored. */
  function handleFrame(record, line) {
    const entry = record.entry;
    if (!entry) return;
    /** @type {any} */
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    try {
      if (frame.t === "i" && typeof frame.d === "string") {
        const text = Buffer.from(frame.d, "base64").toString("utf8");
        if (text) onInput?.(entry, text);
      } else if (frame.t === "r") {
        onResize?.(entry, frame.c, frame.r);
      } else if (frame.t === "c") {
        detach(record);
        try {
          record.socket.end();
        } catch {
          // ignore
        }
      }
    } catch (error) {
      log.warn(`[dsh-remote] terminal bridge frame handling failed: ${messageOf(error)}`);
    }
  }

  /** Parse the handshake first, then one frame per line. */
  function onData(record, data) {
    try {
      if (record.closed) return;
      record.buffer += data;
      for (;;) {
        const newline = record.buffer.indexOf("\n");
        if (newline === -1) break;
        const line = record.buffer.slice(0, newline).trim();
        record.buffer = record.buffer.slice(newline + 1);
        if (!line) continue;
        if (!record.handshakeDone) {
          if (!handleHandshake(record, line)) return;
        } else {
          handleFrame(record, line);
        }
      }
      if (!record.handshakeDone && record.buffer.length > MAX_HANDSHAKE_LINE_CHARS) {
        log.warn("[dsh-remote] terminal bridge sent an oversized handshake; closing");
        destroy(record);
      }
    } catch (error) {
      log.warn(`[dsh-remote] terminal bridge data handling failed: ${messageOf(error)}`);
      destroy(record);
    }
  }

  /** Accept one connection; never throws out of the net server callback. */
  function onConnection(socket) {
    /** @type {BridgeRecord} */
    const record = {
      socket,
      entry: null,
      buffer: "",
      handshakeDone: false,
      closed: false,
      handshakeTimer: null,
    };
    try {
      socket.setEncoding("utf8");
      socket.setNoDelay?.(true);
      records.add(record);
      record.handshakeTimer = setTimeout(() => {
        record.handshakeTimer = null;
        if (record.handshakeDone) return;
        log.warn("[dsh-remote] terminal bridge handshake timed out; closing");
        destroy(record);
      }, SOCKET_HANDSHAKE_TIMEOUT_MS);
      socket.on("data", (data) => onData(record, String(data)));
      socket.on("error", (error) => {
        log.debug(`[dsh-remote] terminal bridge socket error: ${messageOf(error)}`);
        detach(record);
      });
      socket.on("close", () => detach(record));
    } catch (error) {
      log.warn(`[dsh-remote] terminal bridge connection failed: ${messageOf(error)}`);
      destroy(record);
    }
  }

  /** Probe whether a live relay already serves `socketPath` (3 tries, ~300 ms). */
  async function probeLiveSocket() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const live = await new Promise((resolve) => {
        /** @type {import("node:net").Socket} */
        let client;
        let settled = false;
        /** @type {NodeJS.Timeout} */
        let timer;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            client.destroy();
          } catch {
            // ignore
          }
          resolve(value);
        };
        try {
          client = net.connect(socketPath);
        } catch {
          resolve(false);
          return;
        }
        timer = setTimeout(() => finish(false), 300);
        timer.unref?.();
        client.once("connect", () => finish(true));
        client.once("error", () => finish(false));
      });
      if (live) return true;
      await new Promise((resolve) => setTimeout(resolve, 20).unref?.());
    }
    return false;
  }

  /** Delete a stale socket file; refuse to remove anything that is not one. */
  function removeStaleSocket() {
    if (process.platform === "win32") return;
    let stats;
    try {
      stats = lstatSync(socketPath);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "ENOENT") return;
      throw error;
    }
    if (!stats.isSocket()) {
      throw Object.assign(
        new Error(`terminal relay socket path ${JSON.stringify(socketPath)} exists and is not a socket`),
        { code: "TERMINAL_ERROR" },
      );
    }
    try {
      unlinkSync(socketPath);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
    }
  }

  /** Create the socket (0700 dir, 0600 socket on POSIX) and listen. */
  async function listen() {
    if (process.platform !== "win32") {
      const dir = path.dirname(socketPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch (error) {
        log.debug(`[dsh-remote] terminal socket dir chmod failed: ${messageOf(error)}`);
      }
    }
    // A live listener is reused (never unlinked); only a verified stale socket
    // file is removed. Detection is async, so probe before touching the path.
    if (process.platform !== "win32") {
      let stats = null;
      try {
        stats = lstatSync(socketPath);
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
      }
      if (stats) {
        if (!stats.isSocket()) {
          throw Object.assign(
            new Error(`terminal relay socket path ${JSON.stringify(socketPath)} exists and is not a socket`),
            { code: "TERMINAL_ERROR" },
          );
        }
        if (await probeLiveSocket()) {
          log.info(`[dsh-remote] terminal relay reusing the live socket at ${socketPath}`);
          external = true;
          return;
        }
        removeStaleSocket();
      }
    }
    const srv = net.createServer((socket) => onConnection(socket));
    srv.on("error", (error) => {
      log.warn(`[dsh-remote] terminal relay server error: ${messageOf(error)}`);
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          srv.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          srv.removeListener("error", onError);
          resolve(undefined);
        };
        srv.once("listening", onListening);
        srv.once("error", onError);
        try {
          srv.listen(socketPath);
        } catch (error) {
          onError(error);
        }
      });
    } catch (error) {
      try {
        srv.close();
      } catch {
        // ignore
      }
      if (/** @type {any} */ (error)?.code === "EADDRINUSE" && (await probeLiveSocket())) {
        log.info(`[dsh-remote] terminal relay reusing the live socket at ${socketPath}`);
        external = true;
        return;
      }
      throw error;
    }
    if (process.platform !== "win32") {
      try {
        chmodSync(socketPath, 0o600);
      } catch (error) {
        log.debug(`[dsh-remote] terminal socket chmod failed: ${messageOf(error)}`);
      }
      ownsSocketFile = true;
    }
    // The optional terminal surface must never be the handle that keeps the DSH
    // Host (or a test process that mounted the plugin) alive on its own.
    try {
      srv.unref?.();
    } catch {
      // ignore
    }
    server = srv;
  }

  /** Start the socket server (idempotent). */
  function start() {
    if (disposed) {
      return Promise.reject(Object.assign(new Error("terminal relay socket has been disposed"), { code: "TERMINAL_ERROR" }));
    }
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!server && !external) await listen();
    })().catch((error) => {
      startPromise = null;
      server = null;
      ownsSocketFile = false;
      throw error;
    });
    return startPromise;
  }

  /** Number of connected bridges for one session. */
  function attached(entry) {
    const set = byEntry.get(entry);
    return set ? set.size : 0;
  }

  /** Broadcast relay output to every bridge attached to one session. */
  function broadcast(entry, text) {
    if (!text) return;
    const set = byEntry.get(entry);
    if (!set) return;
    for (const record of [...set]) {
      if (!record.closed) writeToBridge(record, text);
    }
  }

  /** End every bridge attached to one session (used when it closes). */
  function endEntry(entry) {
    const set = byEntry.get(entry);
    if (!set) return;
    for (const record of [...set]) {
      detach(record);
      try {
        record.socket.end();
      } catch {
        // ignore
      }
    }
    byEntry.delete(entry);
  }

  /** Close the server and every connection (quiescent, idempotent). */
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      // End the live bridges *before* awaiting `server.close()`: the close
      // callback only fires once every accepted connection is gone, so waiting
      // first would deadlock while a native terminal is still attached.
      for (const record of [...records]) {
        detach(record);
        try {
          record.socket.end();
        } catch {
          // ignore
        }
        try {
          record.socket.destroy();
        } catch {
          // ignore
        }
      }
      const srv = server;
      server = null;
      if (srv) {
        await new Promise((resolve) => {
          try {
            srv.close(() => resolve(undefined));
          } catch {
            resolve(undefined);
          }
        });
      }
      records.clear();
      byEntry.clear();
      if (process.platform !== "win32" && ownsSocketFile && !external) {
        try {
          if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "ENOENT") {
            log.debug(`[dsh-remote] terminal socket cleanup failed: ${messageOf(error)}`);
          }
        }
      }
      ownsSocketFile = false;
    })().catch((error) => {
      log.warn(`[dsh-remote] terminal relay socket dispose failed: ${messageOf(error)}`);
    });
    return /** @type {Promise<void>} */ (disposePromise);
  }

  return {
    start,
    dispose,
    attached,
    broadcast,
    endEntry,
    socketPath,
    get isStarted() {
      return server !== null || external;
    },
    get isExternal() {
      return external;
    },
  };
}
