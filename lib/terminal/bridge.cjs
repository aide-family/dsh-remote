/**
 * dsh-remote terminal bridge — the local end of the interactive SSH terminal.
 *
 * Runs *inside* DSH's native terminal (spawned by `bin/dsh-remote-terminal`,
 * which `relay.open().shell.command` types into a fresh shell). It connects to
 * the relay's local socket, sends one JSON-line handshake and then:
 *
 * - pipes its stdin to `{"t":"i","d":"<base64>"}` frames (raw terminal bytes),
 * - forwards the server's raw UTF-8 PTY text to stdout (xterm renders it),
 * - forwards terminal resizes as `{"t":"r","c":cols,"r":rows}`,
 * - reconnects every 1 s (bounded to 120 attempts) when the socket drops, so a
 *   DSH Host restart also recovers (120 retries total per bridge process),
 * - exits cleanly on stdin EOF / SIGINT / SIGTERM, restoring the tty.
 *
 * CommonJS and node builtins only: the package is ESM, so this file is the
 * process boundary that must not depend on the plugin's module graph.
 *
 * Usage:
 *   node lib/terminal/bridge.cjs --host <name> --session <id> --socket <path>
 */

"use strict";

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const HANDSHAKE_PREFIX = Buffer.from("\u001eDSHREMOTE/1 ");
const HANDSHAKE_TIMEOUT_MS = 2_000;

const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 120;
const EXIT_FLUSH_MS = 100;

/**
 * Bounded on-disk diagnostics (v0.5.1): `terminal-bridge.log` next to the
 * relay socket. "Bridge never ran" = no file; "bridge ran but could not
 * attach" = error lines. Best-effort only: logging must never change behavior.
 */
const LOG_FILE_NAME = "terminal-bridge.log";
const LOG_MAX_BYTES = 256 * 1024;
const LOG_KEEP_BYTES = 64 * 1024;

const BANNER_DISCONNECTED = "\x1b[33m[dsh-remote] 终端桥接断开，正在重连…\x1b[0m\r\n";
const BANNER_EXHAUSTED =
  "\x1b[31m[dsh-remote] 终端桥接重连失败，请重新打开终端（Ctrl-C 退出）。\x1b[0m\r\n";

/**
 * @typedef {object} BridgeOptions
 * @property {string} host
 * @property {string} session
 * @property {string} socket
 */

/**
 * Parse `--host/--session/--socket` (supports both `--flag value` and
 * `--flag=value`).
 *
 * @param {string[]} argv
 * @returns {BridgeOptions}
 */
function parseArgs(argv) {
  const options = { host: "", session: "", socket: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--(host|session|socket)(?:=(.*))?$/u.exec(argument);
    if (!match) continue;
    const key = /** @type {"host"|"session"|"socket"} */ (match[1]);
    if (match[2] !== undefined) {
      options[key] = match[2];
    } else if (index + 1 < argv.length) {
      index += 1;
      options[key] = argv[index];
    }
  }
  return options;
}

/**
 * Diagnostics path: next to the relay socket. A Windows named pipe has no
 * writable directory, so fall back to `$DSH_HOME/remote/terminal-bridge.log`.
 *
 * @param {string} socket
 * @returns {string}
 */
function resolveLogPath(socket) {
  if (socket.startsWith("\\\\.\\pipe\\")) {
    const home = (process.env.DSH_HOME || "").trim() || path.join(os.homedir(), ".dsh");
    return path.join(home, "remote", LOG_FILE_NAME);
  }
  return path.join(path.dirname(socket), LOG_FILE_NAME);
}

/**
 * Append one diagnostics line, trimming the file to its last 64 KiB once it
 * grows past 256 KiB. Swallows every error (read-only dir, race, ...).
 *
 * @param {string} filePath
 * @param {string} message
 */
function appendLog(filePath, message) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`, "utf8");
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= LOG_MAX_BYTES) return;
    const raw = fs.readFileSync(filePath);
    let start = Math.max(0, raw.length - LOG_KEEP_BYTES);
    const newline = raw.indexOf(10, start);
    fs.writeFileSync(filePath, raw.subarray(newline === -1 ? start : newline + 1));
  } catch {
    // diagnostics are best-effort and must never throw into the bridge
  }
}

/** @param {string} text */
function writeStdout(text) {
  try {
    process.stdout.write(text);
  } catch {
    // The terminal is gone; nothing left to do.
  }
}

/**
 * @param {BridgeOptions} options
 */
function main(options) {
  if (!options.socket) {
    process.stderr.write(
      "usage: dsh-remote-terminal --host <name> --session <id> --socket <path>\n",
    );
    process.exit(2);
    return;
  }

  let socket = null;
  let connected = false;
  let attached = false;
  let handshakeTimer = null;
  let exiting = false;
  let reconnectAttempts = 0;
  /** @type {NodeJS.Timeout|null} */
  let reconnectTimer = null;
  let rawModeSet = false;
  const logPath = resolveLogPath(options.socket);
  /** @param {string} message */
  function log(message) {
    appendLog(logPath, `[dsh-remote-bridge] ${message}`);
  }

  log(
    `start host=${JSON.stringify(options.host)} session=${JSON.stringify(options.session)} ` +
      `socket=${JSON.stringify(options.socket)} node=${process.version} execPath=${JSON.stringify(process.execPath)} pid=${process.pid}`,
  );
  writeStdout(CLEAR_SCREEN);

  function restoreTerminal() {
    if (!rawModeSet) return;
    rawModeSet = false;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // stdin may already be gone
    }
  }

  /** @param {object} frame */
  function sendFrame(frame) {
    if (!socket || !connected || !socket.writable || (frame.t !== "c" && !attached)) return;
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // The close handler schedules the reconnect.
    }
  }

  /** @param {string} text */
  function sendInput(text) {
    if (!text) return;
    sendFrame({ t: "i", d: Buffer.from(text, "utf8").toString("base64") });
  }

  function sendResize() {
    const cols = Number.isFinite(process.stdout.columns) && process.stdout.columns > 0 ? process.stdout.columns : 120;
    const rows = Number.isFinite(process.stdout.rows) && process.stdout.rows > 0 ? process.stdout.rows : 40;
    sendFrame({ t: "r", c: cols, r: rows });
  }

  /** @param {number} code */
  function shutdown(code) {
    if (exiting) return;
    exiting = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    restoreTerminal();
    log(`exit code=${code}`);
    sendFrame({ t: "c" });
    try {
      socket?.end();
    } catch {
      // ignore
    }
    // Let the close/EOF write flush before the process disappears.
    setTimeout(() => process.exit(code), EXIT_FLUSH_MS);
  }

  function scheduleReconnect() {
    if (exiting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`exhausted after ${reconnectAttempts} reconnect attempts`);
      writeStdout(BANNER_EXHAUSTED);
      restoreTerminal();
      setTimeout(() => process.exit(1), EXIT_FLUSH_MS);
      return;
    }
    reconnectAttempts += 1;
    log(`reconnect attempt=${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    writeStdout(BANNER_DISCONNECTED);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (exiting) return;
    const current = net.connect(options.socket);
    socket = current;
    const nonce = randomBytes(12).toString("hex");
    let awaitingHandshake = true;
    let prelude = Buffer.alloc(0);
    function acceptOrLegacy() {
      awaitingHandshake = false;
      attached = true;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      sendResize();
    }
    function legacy() {
      acceptOrLegacy();
      if (prelude.length) process.stdout.write(prelude);
      prelude = Buffer.alloc(0);
    }
    function receive(chunk) {
      if (!awaitingHandshake) { process.stdout.write(chunk); return; }
      prelude = Buffer.concat([prelude, Buffer.from(chunk)]);
      const size = Math.min(prelude.length, HANDSHAKE_PREFIX.length);
      if (!prelude.subarray(0, size).equals(HANDSHAKE_PREFIX.subarray(0, size))) { legacy(); return; }
      const end = prelude.indexOf(10);
      if (end < 0) { if (prelude.length > 4096) legacy(); return; }
      let reply;
      try { reply = JSON.parse(prelude.subarray(HANDSHAKE_PREFIX.length, end).toString("utf8")); }
      catch { legacy(); return; }
      if (end > 4096 || !reply || typeof reply !== "object" || reply.v !== 1 || reply.nonce !== nonce || !["accepted", "rejected"].includes(reply.status)) { legacy(); return; }
      if (reply.status === "rejected") {
        clearTimeout(handshakeTimer); handshakeTimer = null;
        if (reply.code === "SESSION_GONE" && reply.retryable === false) {
          log("session gone; automatic bridge reconnect stopped");
          writeStdout("\r\n[dsh-remote] 原 SSH 会话已关闭，已停止重连。请手动重新连接；不会自动重放命令。\r\n");
          shutdown(1);
        } else {
          // Unknown/retryable rejection is not proof that the old PTY is gone.
          current.destroy();
        }
        prelude = Buffer.alloc(0);
        return;
      }
      const remainder = prelude.subarray(end + 1);
      prelude = Buffer.alloc(0);
      acceptOrLegacy();
      if (remainder.length) process.stdout.write(remainder);
    }

    current.on("connect", () => {
      if (exiting) {
        current.destroy();
        return;
      }
      connected = true;
      attached = false;
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (!exiting && socket === current && awaitingHandshake) legacy();
      }, HANDSHAKE_TIMEOUT_MS);
      // A reachable socket is not an accepted SSH session. Keep a lifetime
      // retry budget: missing/closed sessions can accept TCP then reject attach.
      log(`connected socket=${JSON.stringify(options.socket)}`);
      if (process.stdout.isTTY) writeStdout(CLEAR_SCREEN);
      try {
        current.write(
          `${JSON.stringify({ v: 1, host: options.host, sessionId: options.session, response: "dsh-remote-handshake-v1", nonce })}\n`,
        );
      } catch {
        // close follows
      }
    });

    current.on("data", (chunk) => {
      if (exiting || socket !== current) return;
      try {
        receive(chunk);
      } catch {
        shutdown(0);
      }
    });

    current.on("error", (error) => {
      // 'close' always follows and owns the retry decision.
      const code = error && error.code ? String(error.code) : "";
      const message = error && error.message ? String(error.message) : String(error);
      log(`connect error code=${JSON.stringify(code)} message=${JSON.stringify(message)}`);
    });

    current.on("close", () => {
      if (socket !== current) return;
      connected = false;
      attached = false;
      clearTimeout(handshakeTimer); handshakeTimer = null;
      socket = null;
      log("close");
      scheduleReconnect();
    });
  }

  // --- stdin: raw tty bytes -> input frames --------------------------------
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      rawModeSet = true;
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data) => {
      if (exiting) return;
      sendInput(typeof data === "string" ? data : String(data));
    });
    process.stdin.on("end", () => shutdown(0));
    process.stdin.on("error", () => shutdown(0));
  } catch {
    shutdown(0);
  }

  // --- resizes -------------------------------------------------------------
  process.stdout.on("resize", () => sendResize());
  process.stdout.on("error", () => shutdown(0));

  // --- signals -------------------------------------------------------------
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGHUP", () => shutdown(0));
  process.on("exit", restoreTerminal);

  connect();
}

main(parseArgs(process.argv.slice(2)));
