/**
 * Live command hub unit tests: event order, replay snapshot, bounds, subscriber
 * isolation and clear.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createLiveHub } from "../../lib/live.js";

test("begin/output/end emit start, output and end events in order", () => {
  const hub = createLiveHub();
  const events = [];
  hub.subscribe((event) => events.push(event));
  const command = hub.begin({ sessionId: "s1", tool: "remote_exec", host: "me", command: "uptime", kind: "exec" });
  command.output("stdout", "12:00 up 9 days\n");
  command.output("stderr", "warning\n");
  command.end({ code: 0, durationMs: 42 });

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "output", "output", "end"],
  );
  assert.equal(events[0].id, command.id);
  assert.equal(events[0].sessionId, "s1");
  assert.equal(events[0].command, "uptime");
  assert.deepEqual(events[1], { type: "output", id: command.id, stream: "stdout", text: "12:00 up 9 days\n" });
  assert.equal(events[2].stream, "stderr");
  assert.deepEqual(events[3], {
    type: "end",
    id: command.id,
    time: events[3].time,
    code: 0,
    error: undefined,
    durationMs: 42,
    status: "done",
  });
  assert.equal(typeof events[3].time, "number");
});

test("end is idempotent and output after end is ignored", () => {
  const hub = createLiveHub();
  const events = [];
  hub.subscribe((event) => events.push(event));
  const command = hub.begin({ tool: "remote_exec", host: "me", command: "x" });
  command.output("stdout", "before\n");
  command.end({ code: 0 });
  command.end({ code: 1 });
  command.output("stdout", "after\n");
  assert.equal(events.filter((event) => event.type === "end").length, 1);
  assert.equal(events.filter((event) => event.type === "output").length, 1);
  assert.equal(hub.snapshot().commands[0].status, "done");
});

test("snapshot replays the retained commands newest last", () => {
  const hub = createLiveHub();
  const first = hub.begin({ sessionId: "a", tool: "remote_exec", host: "me", command: "one", kind: "exec" });
  first.output("stdout", "1\n");
  first.end({ code: 0, durationMs: 5 });
  const second = hub.begin({ sessionId: "b", tool: "remote_shell_send", host: "me", command: "two", kind: "shell" });
  second.output("stdout", "2\n");

  const snapshot = hub.snapshot();
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.commands.length, 2);
  assert.deepEqual(
    snapshot.commands.map((command) => command.command),
    ["one", "two"],
  );
  assert.equal(snapshot.commands[0].status, "done");
  assert.equal(snapshot.commands[0].output, "1\n");
  assert.equal(snapshot.commands[1].status, "running");
  assert.equal(snapshot.commands[1].sessionId, "b");
});

test("per-command output keeps the tail and marks truncation", () => {
  const hub = createLiveHub({ maxOutputPerCommand: 10, maxTotalOutput: 1_000 });
  const command = hub.begin({ tool: "remote_exec", host: "me", command: "x" });
  command.output("stdout", "0123456789ABCDEF");
  const snapshot = hub.snapshot().commands[0];
  assert.equal(snapshot.output, "6789ABCDEF");
  assert.equal(snapshot.outputTruncated, true);
});

test("command count and total output stay bounded", () => {
  const hub = createLiveHub({ maxCommands: 3, maxTotalOutput: 12, maxOutputPerCommand: 100 });
  for (let index = 0; index < 5; index += 1) {
    const command = hub.begin({ tool: "remote_exec", host: "me", command: `cmd-${index}` });
    command.output("stdout", "0123456789");
    command.end({ code: 0 });
  }
  const snapshot = hub.snapshot();
  assert.ok(snapshot.commands.length <= 3);
  const total = snapshot.commands.reduce((sum, command) => sum + command.output.length, 0);
  assert.ok(total <= 12, `retained output ${total} exceeds the cap`);
  // The newest command is always retained.
  assert.equal(snapshot.commands.at(-1).command, "cmd-4");
});

test("note() writes a note stream event and is retained", () => {
  const hub = createLiveHub();
  const events = [];
  hub.subscribe((event) => events.push(event));
  const command = hub.begin({ tool: "remote_shell_open", host: "me", command: "open shell", kind: "shell-open" });
  command.note("shell live-1 started");
  assert.deepEqual(events.at(-1), { type: "output", id: command.id, stream: "note", text: "shell live-1 started" });
  assert.match(hub.snapshot().commands[0].output, /shell live-1 started/);
});

test("subscriber errors are isolated and clear notifies listeners", () => {
  const hub = createLiveHub();
  const seen = [];
  hub.subscribe(() => {
    throw new Error("boom");
  });
  hub.subscribe((event) => seen.push(event.type));
  hub.begin({ tool: "remote_exec", host: "me", command: "x" });
  assert.deepEqual(seen, ["start"]);
  hub.clear();
  assert.deepEqual(seen, ["start", "clear"]);
  assert.equal(hub.snapshot().commands.length, 0);
  assert.equal(hub.size, 0);
});

test("unsubscribe stops delivery", () => {
  const hub = createLiveHub();
  const seen = [];
  const off = hub.subscribe((event) => seen.push(event.type));
  hub.begin({ tool: "remote_exec", host: "me", command: "x" });
  off();
  hub.begin({ tool: "remote_exec", host: "me", command: "y" });
  assert.deepEqual(seen, ["start"]);
  assert.equal(hub.subscriberCount, 0);
});

test("sessionId and identifiers default safely", () => {
  const hub = createLiveHub();
  const command = hub.begin({});
  const snapshot = hub.snapshot().commands[0];
  assert.equal(snapshot.sessionId, null);
  assert.equal(snapshot.tool, "remote");
  assert.equal(snapshot.host, "—");
  assert.equal(snapshot.kind, "exec");
  command.end({ error: "denied: read-only host" });
  const ended = hub.snapshot().commands[0];
  assert.equal(ended.status, "error");
  assert.equal(ended.error, "denied: read-only host");
});
