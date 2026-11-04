import assert from "node:assert/strict";
import test from "node:test";
import { authorizeConnectionLogin, waitForLoginPrompt, runConnectionLogin } from "../../lib/terminal/connection-login.js";

const host = { name: "cluster-a", host: "192.0.2.10", viaHost: "bastion-demo", loginCommand: "sww -r -u demo.user cluster-a" };
class Pty {
  data = new Set(); exit = new Set(); writes = []; closed = false;
  onData(fn) { this.data.add(fn); return () => this.data.delete(fn); }
  onExit(fn) { this.exit.add(fn); return () => this.exit.delete(fn); }
  emit(text) { for (const fn of [...this.data]) fn(text); }
  write(text) { this.writes.push(text); this.emit("\r\nroot@web1.cluster-a.example.test:~# "); }
  status() { return { kind: this.closed ? "exited" : "running" }; }
}

test("auto login respects validation, deny patterns, readonly and strict policies", async () => {
  assert.equal(await authorizeConnectionLogin({ name: "normal" }), null);
  assert.deepEqual(await authorizeConnectionLogin(host, { config: { policy: "auto" } }), { viaHost: "bastion-demo", actions: [{ type: "command", value: host.loginCommand, expectCluster: "cluster-a" }] });
  await assert.rejects(authorizeConnectionLogin({ ...host, loginCommand: "sww -r -u user cluster-a; reboot" }), { code: "HOST_INVALID" });
  for (const config of [{ policy: "never" }, { policy: "always" }, { policy: "auto", unprovenCommands: "ask" }, { policy: "auto", denyCommandPatterns: ["sww"] }]) {
    await assert.rejects(authorizeConnectionLogin(host, { config }), { code: "LOGIN_DENIED" });
  }
  await assert.rejects(authorizeConnectionLogin(host, { config: { policy: "auto" }, hosts: { isReadonly: () => true } }), { code: "LOGIN_DENIED" });
});

test("login waits for entry prompt then sends exactly once and verifies the target", async () => {
  const pty = new Pty();
  const login = runConnectionLogin(pty, { profile: host, timeoutMs: 500 });
  pty.emit("Connecting ...\r\n");
  assert.deepEqual(pty.writes, []);
  pty.emit("\u001b[32m[demo.user@entry-demo ~]$ \u001b[0m");
  await login;
  assert.deepEqual(pty.writes, [host.loginCommand + "\r"]);
  assert.equal(pty.data.size, 0);
  assert.equal(pty.exit.size, 0);
});

test("an old startup banner or wrong cluster prompt does not confirm target login", async () => {
  const pty = new Pty();
  const pending = waitForLoginPrompt(pty, { targetCluster: "cluster-a", timeoutMs: 15 });
  pty.emit("Switched to context cluster-a\r\nroot@web1.other.example.test:~# ");
  await assert.rejects(pending, { code: "LOGIN_TIMEOUT" });
  assert.equal(pty.data.size, 0);
});

test("absence of entry prompt never sends a login command", async () => {
  const pty = new Pty();
  await assert.rejects(runConnectionLogin(pty, { profile: host, timeoutMs: 15 }), { code: "LOGIN_TIMEOUT" });
  assert.deepEqual(pty.writes, []);
});

test("entry prompt may be buffered and target prompt may arrive in chunks", async () => {
  const pty = new Pty();
  pty.write = function(text) { this.writes.push(text); this.emit("root@web1.cluster-"); this.emit("a.example.test:~# "); };
  await runConnectionLogin(pty, { profile: host, initialOutput: "[demo.user@entry-demo ~]$ ", timeoutMs: 100 });
  assert.equal(pty.writes.length, 1);
});

test("PTY exit and abort stop prompt wait immediately", async () => {
  const pty = new Pty();
  const pending = waitForLoginPrompt(pty, { timeoutMs: 500 });
  for (const fn of [...pty.exit]) fn();
  await assert.rejects(pending, { code: "LOGIN_EXIT" });
  const controller = new AbortController();
  const cancelled = waitForLoginPrompt(pty, { signal: controller.signal, timeoutMs: 500 });
  controller.abort();
  await assert.rejects(cancelled, { code: "LOGIN_CANCELLED" });
  assert.equal(pty.data.size, 0);
});

test("cancellation after synchronous entry prompt does not send sww", async () => {
  const pty = new Pty();
  const controller = new AbortController();
  const pending = runConnectionLogin(pty, { profile: host, initialOutput: "root@web1.entry:~# ", signal: controller.signal, timeoutMs: 500 });
  controller.abort();
  await assert.rejects(pending, { code: "LOGIN_CANCELLED" });
  assert.deepEqual(pty.writes, []);
  assert.equal(pty.data.size, 0);
});

test("cancellation inside onCommand does not send sww", async () => {
  const pty = new Pty();
  const controller = new AbortController();
  await assert.rejects(runConnectionLogin(pty, { profile: host, initialOutput: "root@web1.entry:~# ", signal: controller.signal, timeoutMs: 500,
    onCommand: () => controller.abort() }), { code: "LOGIN_CANCELLED" });
  assert.deepEqual(pty.writes, []);
  assert.equal(pty.data.size, 0);
});

test("write failure cleans target listener without waiting for timeout", async () => {
  const pty = new Pty();
  pty.write = () => { throw new Error("write failed"); };
  await assert.rejects(runConnectionLogin(pty, { profile: host, initialOutput: "[demo.user@entry-demo ~]$ ", timeoutMs: 500 }), (error) => {
    assert.match(error.message, /action 1\/1 \(command\): Execution failed/);
    assert.equal(error.cause.message, "write failed");
    return true;
  });
  assert.equal(pty.data.size, 0);
});
