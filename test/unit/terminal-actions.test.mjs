import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConnectionProfile, normalizeTerminalActions, TERMINAL_ACTION_KEYS } from "../../lib/connection-profile.js";
import { authorizeConnectionLogin, runConnectionLogin } from "../../lib/terminal/connection-login.js";
import { createHostRegistry } from "../../lib/host-registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = "ops@entry:~$ ";
const profileOf = (actions) => ({ viaHost: "entry", actions });
class Pty {
  data = new Set(); exit = new Set(); writes = []; closed = false;
  onData(fn) { this.data.add(fn); return () => this.data.delete(fn); }
  onExit(fn) { this.exit.add(fn); return () => this.exit.delete(fn); }
  emit(text) { for (const fn of [...this.data]) fn(text); }
  write(text) { this.writes.push(text); this.respond?.(text); }
  close() { this.closed = true; for (const fn of [...this.exit]) fn(); }
  status() { return { kind: this.closed ? "exited" : "running" }; }
}
const run = (pty, actions, options = {}) => runConnectionLogin(pty, { profile: profileOf(actions), initialOutput: entry, ...options });

test("action shapes normalize without injecting defaults and are defensive copies", () => {
  const actions = [
    { type: "command", value: "hostname", expect: "literal.*", timeoutMs: 100, label: "Host" },
    { type: "text", value: "菜单" }, { type: "key", value: "Enter" },
    { type: "wait", value: "Ready\n" }, { type: "delay", durationMs: 0 },
  ];
  const normalized = normalizeConnectionProfile(profileOf(actions));
  assert.deepEqual(normalized, profileOf(actions));
  assert.notEqual(normalized.actions, actions);
  assert.notEqual(normalized.actions[0], actions[0]);
  actions[0].value = "mutated";
  assert.equal(normalized.actions[0].value, "hostname");
  assert.deepEqual(normalizeConnectionProfile({ viaHost: "entry", loginCommand: "invalid legacy", actions: [{ type: "text", value: "x" }] }), profileOf([{ type: "text", value: "x" }]));
});

test("validation rejects partial profiles, secret/unknown fields, controls and bounds", () => {
  for (const actions of [[], Array(1), Array(33).fill({ type: "delay", durationMs: 0 }), null, [null], [{ type: "constructor" }]]) {
    assert.throws(() => normalizeConnectionProfile(profileOf(actions)), { code: "HOST_INVALID" });
  }
  const bad = [
    { type: "command", value: "" }, { type: "text", value: "a".repeat(4097) },
    ...["\0", "\r", "\n", "\t", "\x1b", "\x7f"].map((c) => ({ type: "command", value: `x${c}` })),
    { type: "key", value: "F1" }, { type: "wait", value: "" }, { type: "wait", value: "x".repeat(2049) },
    { type: "wait", value: "x\x1b" }, { type: "command", value: "id", expect: "\0" },
    { type: "command", value: "id", expectCluster: "x;id" }, { type: "command", value: "id", expect: "x", expectCluster: "x" },
    ...[99, 120001, 0, 2.5, "100"].map((timeoutMs) => ({ type: "text", value: "x", timeoutMs })),
    ...[-1, 120001, 0.5, undefined].map((durationMs) => ({ type: "delay", durationMs })),
    { type: "delay", durationMs: 0, value: "x" }, { type: "key", value: "Enter", expectCluster: "x" },
    ...["", "x".repeat(81), "x\n"].map((label) => ({ type: "text", value: "x", label })),
    ...["password", "passphrase", "secret", "token", "unexpected"].map((field) => ({ type: "text", value: "x", [field]: "secret" })),
  ];
  for (const action of bad) assert.throws(() => normalizeTerminalActions([action]), { code: "HOST_INVALID" });
  assert.throws(() => normalizeConnectionProfile({ actions: [{ type: "text", value: "x" }] }), { code: "HOST_INVALID" });
});

test("all allowed key bytes are exact and each is written once", async () => {
  for (const [key, bytes] of Object.entries(TERMINAL_ACTION_KEYS)) {
    const pty = new Pty();
    await run(pty, [{ type: "key", value: key }]);
    assert.deepEqual(pty.writes, [bytes]);
    assert.equal(pty.data.size, 0);
  }
});

test("command/text/key/wait/delay execute sequentially with synchronous output", async () => {
  const pty = new Pty();
  pty.respond = (text) => {
    if (text === "hostname\r") { pty.emit("node\r\n"); pty.emit(entry); }
    else if (text === "choice") pty.emit("Selected");
    else if (text === "\r") pty.emit(" Ready.*");
    else if (text === "finish\r") pty.emit("ALL DONE");
  };
  const commands = [], progress = [];
  await run(pty, [
    { type: "command", value: "hostname", label: "Inspect" },
    { type: "text", value: "choice" }, { type: "key", value: "Enter" },
    { type: "wait", value: "Selected Ready.*", timeoutMs: 100 },
    { type: "delay", durationMs: 1 }, { type: "command", value: "finish", expect: "ALL DONE" },
  ], { onCommand: (value) => commands.push(value), onProgress: (value) => progress.push(value) });
  assert.deepEqual(pty.writes, ["hostname\r", "choice", "\r", "finish\r"]);
  assert.deepEqual(commands, ["hostname", "finish"]);
  assert.deepEqual(progress.at(-1), { state: "completed", total: 6, index: 6, completed: 6 });
  assert.deepEqual(progress.filter((p) => p.state === "running").map((p) => p.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(progress.every((p) => Object.keys(p).every((k) => ["state", "total", "index", "completed", "type", "label"].includes(k))));
  assert.equal(pty.data.size, 0); assert.equal(pty.exit.size, 0);
});

test("first wait allows a menu entrance and navigation under unproven allow", async () => {
  const pty = new Pty();
  const actions = [{ type: "wait", value: "Choose target", timeoutMs: 100 }, { type: "key", value: "ArrowDown" }, { type: "key", value: "Enter", expect: "Connected" }];
  const profile = await authorizeConnectionLogin(profileOf(actions), { config: { policy: "auto", unprovenCommands: "allow" } });
  pty.respond = (text) => { if (text === "\r") pty.emit("Connected"); };
  const pending = runConnectionLogin(pty, { profile });
  assert.deepEqual(pty.writes, []);
  pty.emit("Choose target");
  await pending;
  assert.deepEqual(pty.writes, ["\x1b[B", "\r"]);
  for (const options of [{ config: { policy: "auto", unprovenCommands: "ask" } }, { config: { policy: "never" } }, { hosts: { isReadonly: () => true } }]) {
    await assert.rejects(authorizeConnectionLogin(profileOf(actions), options), { code: "LOGIN_DENIED" });
  }
});

test("default command cannot reuse an earlier prompt", async () => {
  const pty = new Pty();
  pty.respond = (text) => { if (text === "first\r") pty.emit(entry); };
  await assert.rejects(run(pty, [{ type: "command", value: "first" }, { type: "command", value: "second", timeoutMs: 100 }, { type: "text", value: "never" }]), { code: "LOGIN_TIMEOUT" });
  assert.deepEqual(pty.writes, ["first\r", "second\r"]);
});

test("a later literal condition cannot reuse completed earlier output", async () => {
  const pty = new Pty();
  pty.respond = () => pty.emit("marker");
  await assert.rejects(run(pty, [{ type: "text", value: "x", expect: "marker" }, { type: "wait", value: "marker", timeoutMs: 100 }, { type: "text", value: "never" }]), { code: "LOGIN_TIMEOUT" });
  assert.deepEqual(pty.writes, ["x"]);
});

test("literal matching strips streaming ANSI and never interprets regex", async () => {
  const pty = new Pty();
  pty.respond = () => { pty.emit("\x1b[3"); pty.emit("2mready.*\x1b[0m"); };
  await run(pty, [{ type: "text", value: "x", expect: "ready.*" }]);
  pty.respond = () => pty.emit("readyAA");
  await assert.rejects(run(pty, [{ type: "text", value: "x", expect: "ready.*", timeoutMs: 100 }]), { code: "LOGIN_TIMEOUT" });
});

test("known high risk and split text submit deny before any writes", async () => {
  for (const actions of [
    [{ type: "command", value: "reboot" }],
    [{ type: "text", value: "re" }, { type: "text", value: "boot" }, { type: "key", value: "Enter" }],
    [{ type: "key", value: "ArrowDown" }, { type: "command", value: "rm -rf /tmp/x" }],
  ]) {
    const pty = new Pty();
    await assert.rejects(run(pty, actions), { code: "LOGIN_DENIED" });
    assert.deepEqual(pty.writes, []);
  }
  const profile = await authorizeConnectionLogin(profileOf([{ type: "text", value: "safe" }]), { config: { policy: "auto", denyCommandPatterns: ["forbidden"] } });
  profile.actions[0].value = "forbidden";
  const pty = new Pty();
  await assert.rejects(runConnectionLogin(pty, { profile, initialOutput: entry }), { code: "LOGIN_DENIED" });
  assert.deepEqual(pty.writes, []);
});

test("wait timeout, PTY exit and cancellation fail-stop and clean subscriptions", async () => {
  for (const mode of ["timeout", "abort", "exit"]) {
    const pty = new Pty();
    const controller = new AbortController();
    const progress = [];
    pty.respond = () => { if (mode === "abort") controller.abort(); if (mode === "exit") pty.close(); };
    await assert.rejects(run(pty, [{ type: "text", value: "start", expect: "never", timeoutMs: 100 }, { type: "text", value: "never" }], { signal: controller.signal, onProgress: (p) => progress.push(p) }), { code: mode === "abort" ? "LOGIN_CANCELLED" : mode === "exit" ? "LOGIN_EXIT" : "LOGIN_TIMEOUT" });
    assert.deepEqual(pty.writes, ["start"]);
    assert.equal(progress.at(-1).state, mode === "abort" ? "cancelled" : "failed");
    assert.equal(pty.data.size, 0); assert.equal(pty.exit.size, 0);
  }
});

test("delay cancels immediately and does not run remaining sends", async () => {
  const pty = new Pty(), controller = new AbortController();
  await assert.rejects(run(pty, [{ type: "delay", durationMs: 120000 }, { type: "text", value: "never" }], { signal: controller.signal,
    onProgress: (p) => { if (p.state === "running") queueMicrotask(() => controller.abort()); } }), { code: "LOGIN_CANCELLED" });
  assert.deepEqual(pty.writes, []); assert.equal(pty.data.size, 0);
});

test("progress callbacks cannot leak raw action values or defeat fail-stop", async () => {
  const pty = new Pty(), controller = new AbortController();
  await assert.rejects(run(pty, [{ type: "text", value: "private-value" }], { signal: controller.signal, onProgress: (p) => {
    assert.ok(!JSON.stringify(p).includes("private-value"));
    if (p.state === "running") controller.abort();
  } }), { code: "LOGIN_CANCELLED" });
  assert.deepEqual(pty.writes, []);
});

test("registry deep copies action arrays on create/list/get/load and update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-actions-"));
  try {
    const registry = createHostRegistry({ filePath: join(dir, "hosts.json") });
    const actions = [{ type: "text", value: "original" }];
    const created = await registry.create({ name: "shortcut", ...profileOf(actions) });
    actions[0].value = "input mutation"; created.actions[0].value = "return mutation";
    const listed = registry.list(); listed[0].actions[0].value = "list mutation";
    const fetched = registry.get("shortcut"); fetched.actions[0].value = "get mutation";
    assert.equal(registry.get("shortcut").actions[0].value, "original");
    const loaded = await createHostRegistry({ filePath: join(dir, "hosts.json") }).load();
    assert.equal(loaded[0].actions[0].value, "original");
    const updated = await registry.update("shortcut", { name: "shortcut", ...profileOf([{ type: "delay", durationMs: 0 }]) });
    updated.actions[0].durationMs = 123;
    assert.equal(registry.get("shortcut").actions[0].durationMs, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("20-minute total deadline fail-stops even an immediately completed action", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const pty = new Pty(), progress = [];
  pty.respond = () => { now = 20 * 60000; pty.emit(entry); };
  await assert.rejects(run(pty, [{ type: "command", value: "hostname" }, { type: "text", value: "never" }], { onProgress: (p) => progress.push(p) }), { code: "LOGIN_TIMEOUT" });
  assert.deepEqual(pty.writes, ["hostname\r"]);
  assert.equal(progress.at(-1).state, "failed");
  assert.equal(progress.at(-1).completed, 0);
});

test("literal completion retains same-chunk suffix for subsequent waits", async () => {
  const pty = new Pty();
  pty.respond = () => pty.emit("firstsecondthird");
  await run(pty, [{ type: "text", value: "x", expect: "first" }, { type: "wait", value: "second", timeoutMs: 100 }, { type: "wait", value: "third", timeoutMs: 100 }]);
  assert.deepEqual(pty.writes, ["x"]);
});

test("errors identify safe failing action number/type without values or output", async () => {
  const actions = [{ type: "text", value: "private-input" }, { type: "wait", value: "private-output", timeoutMs: 100 }];
  const pty = new Pty();
  await assert.rejects(run(pty, actions), (error) => {
    assert.equal(error.code, "LOGIN_TIMEOUT");
    assert.match(error.message, /action 2\/2 \(wait\)/);
    assert.ok(!error.message.includes("private-input") && !error.message.includes("private-output"));
    assert.equal(error.cause.code, "LOGIN_TIMEOUT");
    return true;
  });
  await assert.rejects(authorizeConnectionLogin(profileOf(actions), { config: { denyCommandPatterns: ["private-input"] } }), (error) => {
    assert.equal(error.code, "LOGIN_DENIED");
    assert.match(error.message, /action 1\/2 \(text\)/);
    assert.ok(!error.message.includes("private-input"));
    return true;
  });
  const failed = new Pty();
  const original = Object.assign(new Error("raw private-input private-output"), { code: "WRITE_FAILED" });
  failed.respond = () => { throw original; };
  await assert.rejects(run(failed, actions), (error) => {
    assert.equal(error.code, "WRITE_FAILED"); assert.equal(error.cause, original);
    assert.match(error.message, /action 1\/2 \(text\): Execution failed/);
    assert.ok(!error.message.includes("private-input") && !error.message.includes("private-output"));
    return true;
  });
  await assert.rejects(run(new Pty(), [{ type: "text", value: "private-input" }], { initialOutput: "", timeoutMs: 1 }), (error) => {
    assert.match(error.message, /entry host shell prompt/);
    assert.ok(!error.message.includes("action 1/1"));
    return true;
  });
});

test("first wait consumes buffered authenticated menu output without a shell prompt", async () => {
  const pty = new Pty();
  await runConnectionLogin(pty, { profile: profileOf([{ type: "wait", value: "Menu", timeoutMs: 100 }, { type: "text", value: "1" }]), initialOutput: "Menu" });
  assert.deepEqual(pty.writes, ["1"]);
});

test("delay is interrupted by PTY exit and literal waits do not authorize sends", async () => {
  const pty = new Pty();
  await assert.rejects(run(pty, [{ type: "delay", durationMs: 120000 }, { type: "text", value: "never" }], {
    onProgress: (p) => { if (p.state === "running") queueMicrotask(() => pty.close()); },
  }), { code: "LOGIN_EXIT" });
  assert.deepEqual(pty.writes, []);
  await assert.rejects(authorizeConnectionLogin(profileOf([{ type: "wait", value: "Menu" }, { type: "command", value: "reboot" }])), { code: "LOGIN_DENIED" });
});

test("default completion accepts a synthetic cluster-b K8S-RONLY prompt in streamed ANSI output", async () => {
  const pty = new Pty();
  const commands = [];
  pty.respond = () => {
    pty.emit("正在连接到集群 cluster-b...\r\n当前集群: cluster-b 未配置SSH访问方式,尝试使用k8s-api访问中...\r\n");
    pty.emit("\x1b[32m[ K8S-RONLY ]root@web1.");
    pty.emit("region-a.example.test:~#\x1b[0m ");
  };
  await run(pty, [{ type: "command", value: "sww -r -u demo.user cluster-b", timeoutMs: 100 }], { onCommand: value => commands.push(value) });
  assert.deepEqual(pty.writes, ["sww -r -u demo.user cluster-b\r"]);
  assert.equal(commands.length, 1);
});

test("tagged entry and command prompts support bracketed and plain identities", async () => {
  for (const prompt of ["[ K8S-RONLY ]root@web1.region-a.example.test:~# ", "[prod] [ops@entry ~]$ ", "[ K8S-RONLY ] root@host:/tmp# ", "[ops@entry ~]$ ", "[ops@entry /tmp/a]]$ "]) {
    const pty = new Pty();
    pty.respond = () => pty.emit(prompt);
    await run(pty, [{ type: "command", value: "hostname", timeoutMs: 100 }], { initialOutput: prompt, timeoutMs: 100 });
    assert.deepEqual(pty.writes, ["hostname\r"]);
  }
});

test("a mode label preserves explicit root verification for a matching target", async () => {
  const pty = new Pty();
  pty.respond = () => pty.emit("[ K8S-RONLY ]root@web1.cluster-b.example.test:~# ");
  await run(pty, [{ type: "command", value: "sww -r -u ops cluster-b", expectCluster: "cluster-b", timeoutMs: 100 }]);
  assert.equal(pty.writes.length, 1);
});

test("a tagged region-a prompt does not satisfy explicit cluster-b target verification", async () => {
  const pty = new Pty();
  pty.respond = () => pty.emit("[ K8S-RONLY ]root@web1.region-a.example.test:~# ");
  await assert.rejects(run(pty, [{ type: "command", value: "sww -r -u ops cluster-b", expectCluster: "cluster-b", timeoutMs: 100 }]), { code: "LOGIN_TIMEOUT" });
  assert.deepEqual(pty.writes, ["sww -r -u ops cluster-b\r"]);
});

test("mode labels and unfinished tagged prompts never mark a command ready", async () => {
  for (const output of ["[ K8S-RONLY ]# ", "[ K8S-RONLY ]connecting...", "[ K8S-RONLY ]root@host:~# echo pending", "[ K8S-RONLY ]root@host:~"]) {
    const pty = new Pty();
    pty.respond = () => pty.emit(output);
    await assert.rejects(run(pty, [{ type: "command", value: "hostname", timeoutMs: 100 }]), { code: "LOGIN_TIMEOUT" });
    assert.equal(pty.writes.length, 1);
  }
});
