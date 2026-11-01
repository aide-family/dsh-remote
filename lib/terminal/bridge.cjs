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
 *   DSH Host restart also recovers,
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

const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 120;
const EXIT_FLUSH_MS = 100;

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
  let exiting = false;
  let reconnectAttempts = 0;
  /** @type {NodeJS.Timeout|null} */
  let reconnectTimer = null;
  let rawModeSet = false;

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
    if (!socket || !connected || !socket.writable) return;
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
    restoreTerminal();
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
      writeStdout(BANNER_EXHAUSTED);
      restoreTerminal();
      setTimeout(() => process.exit(1), EXIT_FLUSH_MS);
      return;
    }
    reconnectAttempts += 1;
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

    current.on("connect", () => {
      if (exiting) {
        current.destroy();
        return;
      }
      connected = true;
      reconnectAttempts = 0;
      if (process.stdout.isTTY) writeStdout(CLEAR_SCREEN);
      try {
        current.write(
          `${JSON.stringify({ v: 1, host: options.host, sessionId: options.session })}\n`,
        );
      } catch {
        // close follows
      }
      sendResize();
    });

    current.on("data", (chunk) => {
      if (exiting) return;
      try {
        process.stdout.write(chunk);
      } catch {
        shutdown(0);
      }
    });

    current.on("error", () => {
      // 'close' always follows and owns the retry decision.
    });

    current.on("close", () => {
      connected = false;
      if (socket === current) socket = null;
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
