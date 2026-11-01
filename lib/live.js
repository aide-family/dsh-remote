/**
 * Live command hub for the right-sidebar terminal.
 *
 * Every remote command the agent executes publishes a `start` event, streamed
 * `output` chunks, and an `end` event. The hub keeps a bounded replay snapshot
 * so a terminal that opens late still shows recent commands, and fans events out
 * to SSE subscribers. It performs no I/O and never throws into the tool path.
 *
 * Event shapes are documented in docs/ARCHITECTURE.md ("Live terminal mirror
 * (v0.4)").
 */

/** Defaults sized for a readable terminal scrollback without unbounded memory. */
export const LIVE_DEFAULTS = Object.freeze({
  maxCommands: 200,
  maxOutputPerCommand: 65_536,
  maxTotalOutput: 1_048_576,
});

/**
 * @param {object} [options]
 * @param {number} [options.maxCommands]
 * @param {number} [options.maxOutputPerCommand]
 * @param {number} [options.maxTotalOutput]
 * @param {{ warn?: (message: string) => void }} [options.logger]
 */
export function createLiveHub(options = {}) {
  const maxCommands = positiveInt(options.maxCommands, LIVE_DEFAULTS.maxCommands);
  const maxOutputPerCommand = positiveInt(options.maxOutputPerCommand, LIVE_DEFAULTS.maxOutputPerCommand);
  const maxTotalOutput = positiveInt(options.maxTotalOutput, LIVE_DEFAULTS.maxTotalOutput);

  /** @type {Map<string, any>} */
  const commands = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<(event: any) => void>} */
  const listeners = new Set();
  let nextId = 1;
  let totalOutput = 0;

  const warn = (message) => {
    try {
      options.logger?.warn?.(message);
    } catch {
      // logging must never break the hub
    }
  };

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        warn(`dsh-remote: live subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Bound one command's retained output to the per-command cap (tail kept). */
  function appendOutput(command, text) {
    if (text.length === 0) return "";
    command.output += text;
    totalOutput += text.length;
    if (command.output.length > maxOutputPerCommand) {
      const dropped = command.output.length - maxOutputPerCommand;
      command.output = command.output.slice(dropped);
      command.outputTruncated = true;
      totalOutput -= dropped;
    }
    trimTotal();
    return command.output;
  }

  /** Keep the hub's total retained output bounded by evicting the oldest data. */
  function trimTotal() {
    while (totalOutput > maxTotalOutput && order.length > 1) {
      const oldestId = order[0];
      const oldest = commands.get(oldestId);
      if (oldest === undefined) {
        order.shift();
        continue;
      }
      if (oldest.output.length > 0) {
        totalOutput -= oldest.output.length;
        oldest.output = "";
        oldest.outputTruncated = true;
      } else {
        commands.delete(oldestId);
        order.shift();
      }
    }
  }

  /** Drop the oldest command when the command count exceeds the cap. */
  function trimCommands() {
    while (order.length > maxCommands) {
      const oldestId = order.shift();
      const oldest = commands.get(oldestId);
      if (oldest !== undefined) {
        totalOutput -= oldest.output.length;
        commands.delete(oldestId);
      }
    }
  }

  function snapshotCommand(command) {
    return {
      id: command.id,
      sessionId: command.sessionId,
      tool: command.tool,
      host: command.host,
      command: command.command,
      kind: command.kind,
      time: command.time,
      status: command.status,
      output: command.output,
      outputTruncated: command.outputTruncated,
      code: command.code,
      error: command.error,
      durationMs: command.durationMs,
      endedAt: command.endedAt,
    };
  }

  /**
   * Begin one live command.
   *
   * @param {object} input
   * @param {string|null} [input.sessionId]
   * @param {string} [input.tool]
   * @param {string} [input.host]
   * @param {string} [input.command]
   * @param {string} [input.kind] "exec" | "shell" | "shell-open" | "shell-signal" | "shell-close"
   * @returns {{ id: string, output: (stream: string, text: string) => void, note: (text: string) => void, end: (info?: object) => void }}
   */
  function begin(input = {}) {
    const id = `live-${nextId}`;
    nextId += 1;
    const command = {
      id,
      sessionId: input.sessionId ?? null,
      tool: String(input.tool ?? "remote"),
      host: String(input.host ?? "—"),
      command: String(input.command ?? ""),
      kind: String(input.kind ?? "exec"),
      time: Date.now(),
      status: "running",
      output: "",
      outputTruncated: false,
      code: undefined,
      error: undefined,
      durationMs: undefined,
      endedAt: undefined,
    };
    commands.set(id, command);
    order.push(id);
    trimCommands();
    emit({
      type: "start",
      id,
      time: command.time,
      sessionId: command.sessionId,
      tool: command.tool,
      host: command.host,
      command: command.command,
      kind: command.kind,
    });

    let ended = false;
    return {
      id,
      output(stream, text) {
        if (ended) return;
        const value = typeof text === "string" ? text : String(text ?? "");
        if (value.length === 0) return;
        appendOutput(command, value);
        emit({ type: "output", id, stream: stream === "stderr" ? "stderr" : "stdout", text: value });
      },
      note(text) {
        if (ended) return;
        const value = typeof text === "string" ? text : String(text ?? "");
        if (value.length === 0) return;
        command.output = appendOutput(command, value);
        emit({ type: "output", id, stream: "note", text: value });
      },
      end(info = {}) {
        if (ended) return;
        ended = true;
        command.status = info.error !== undefined && info.error !== null ? "error" : "done";
        command.code = Number.isFinite(info.code) ? info.code : undefined;
        command.error = info.error === undefined || info.error === null ? undefined : String(info.error);
        command.durationMs = Number.isFinite(info.durationMs) ? info.durationMs : undefined;
        command.endedAt = Date.now();
        emit({
          type: "end",
          id,
          time: command.endedAt,
          code: command.code,
          error: command.error,
          durationMs: command.durationMs,
          status: command.status,
        });
      },
    };
  }

  /** Bounded replay snapshot: newest commands last. */
  function snapshot() {
    return { type: "snapshot", commands: order.map((id) => snapshotCommand(commands.get(id))).filter(Boolean) };
  }

  /** Subscribe to every live event; returns the unsubscribe function. */
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("live hub: listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Forget every retained command and tell subscribers to clear the terminal. */
  function clear() {
    commands.clear();
    order.length = 0;
    totalOutput = 0;
    emit({ type: "clear" });
    return { cleared: true };
  }

  return {
    begin,
    snapshot,
    subscribe,
    clear,
    get size() {
      return order.length;
    },
    get subscriberCount() {
      return listeners.size;
    },
  };
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
