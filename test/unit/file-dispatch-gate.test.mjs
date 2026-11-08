import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileChangeTools } from "../../lib/file-change-tools.js";

function denied(code) { return Object.assign(new Error("Dispatch gate rejected the current policy."), { code }); }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-file-dispatch-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = { id: "config:fixture", name: "fixture", host: "192.0.2.20", username: "ops" };
  const state = { allowed: true, readonly: false, checks: "none", connection: "same", always: false, commandDenied: false };
  const files = new Map([["/etc/demo", Buffer.from("old\n")]]);
  const events = [];
  const transport = {
    async stat(_host, path) {
      events.push("stat");
      const content = files.get(path);
      if (!content) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { type: "file", size: content.length, mode: 0o600, uid: 1000, gid: 1000 };
    },
    async readFile(_host, path) { events.push("read"); return { content: files.get(path), truncated: false }; },
    async writeFile(_host, path, content) {
      events.push("write"); files.set(path, Buffer.from(content));
      if (options.afterWrite) await options.afterWrite(state);
      return { bytesWritten: content.length };
    },
    async exec() { events.push("execute-verify"); return { code: 0, timedOut: false, signal: null }; },
  };
  const gateCalls = [];
  const tools = createFileChangeTools({ defineTool: value => value, transport, maxReadBytes: 800000, maxOutputBytes: 200000, execTimeoutMs: 1000,
    backupRoot: root, render: { remote_write: () => [], remote_edit: () => [], remote_restore: () => [] },
    prepareHost: async () => host, expandRemotePath: async (_host, path) => path,
    approval: { assessCommand: command => ({ level: command === "mutating-check" ? "high" : "low", ...(state.commandDenied ? { denied: "changed deny rule" } : {}) }) },
    authorizeAction: async request => {
      events.push(request.action === "write" ? "approve-write" : "approve-verify");
      if (options.onAuthorize) await options.onAuthorize(request, state);
      return request.action === "execute" && options.autoVerify ? { allowed: true } : { allowed: true, outcome: "allowed-once" };
    },
    assertSftpMutation: () => { if (state.checks !== "none") throw denied("TARGET_SFTP_UNSUPPORTED"); },
    dispatchSnapshot: () => ({ expectedChecksHash: state.checks, expectedConnectionDigest: state.connection, privateMarker: "private-gate-state" }),
    revalidateDispatch: async (_host, snapshot, dispatchOptions) => {
      events.push(dispatchOptions.sftp ? "gate-write" : "gate-verify");
      gateCalls.push({ snapshot, options: dispatchOptions });
      if (!state.allowed || (dispatchOptions.mutating && state.readonly)) throw denied("DENIED");
      if (dispatchOptions.sftp && state.checks !== "none") throw denied("TARGET_SFTP_UNSUPPORTED");
      if (snapshot.expectedChecksHash !== state.checks || snapshot.expectedConnectionDigest !== state.connection) throw denied("TARGET_CONFIG_CHANGED");
      if (state.always && !dispatchOptions.approvedOnce) throw denied("DENIED");
      if (dispatchOptions.command && state.commandDenied) throw denied("DENIED");
    },
    beginLive: () => undefined, sessionIdOf: () => null,
  });
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  const exec = { signal: new AbortController().signal, agent: { id: "fixture-owner" } };
  const run = (name, args) => byName[name].execute({ host: host.name, ...args }, exec);
  return { root, state, events, files, gateCalls, run };
}

test("write/edit dispatch rejects target checks, allow, readonly or connection changes during approval", async t => {
  for (const name of ["remote_write", "remote_edit"]) {
    for (const change of [state => { state.checks = "new-checks"; }, state => { state.allowed = false; }, state => { state.readonly = true; }, state => { state.connection = "different"; }]) {
      const f = await fixture(t, { onAuthorize: async (_request, state) => change(state) });
      const args = name === "remote_write" ? { path: "/etc/demo", content: "new\n" } : { path: "/etc/demo", old_string: "old", new_string: "new" };
      await assert.rejects(f.run(name, args), error => {
        assert.equal(error.change.writeAttempted, false);
        assert.ok(error.change.backupId);
        assert.ok(["DENIED", "TARGET_SFTP_UNSUPPORTED", "TARGET_CONFIG_CHANGED"].includes(error.code));
        return true;
      });
      assert.equal(f.events.filter(event => event === "write").length, 0);
      assert.equal(f.events.filter(event => event === "execute-verify").length, 0);
      assert.equal(f.files.get("/etc/demo").toString(), "old\n");
    }
  }
});

test("independent verification approval can activate checks but cannot allow the pending SFTP write", async t => {
  const f = await fixture(t, { onAuthorize: async (request, state) => { if (request.action === "execute") state.checks = "new-checks"; } });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new\n", verify_command: "check" }), error => error.code === "TARGET_SFTP_UNSUPPORTED" && error.change.writeAttempted === false);
  assert.equal(f.events.filter(event => event === "write").length, 0);
  assert.equal(f.events.filter(event => event === "execute-verify").length, 0);
});

test("post-write target/deny changes prevent verification execution and retain recovery facts", async t => {
  for (const change of [state => { state.checks = "new-checks"; }, state => { state.allowed = false; }, state => { state.commandDenied = true; }]) {
    const f = await fixture(t, { afterWrite: async state => change(state) });
    await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new\n", verify_command: "check" }), error => {
      assert.equal(error.change.writeAttempted, true);
      assert.ok(error.change.afterVersion);
      assert.equal(error.change.verification.status, "unknown");
      assert.ok(error.change.backupId);
      assert.ok(!JSON.stringify(error.change).includes("private-gate-state"));
      return true;
    });
    assert.equal(f.events.filter(event => event === "write").length, 1);
    assert.equal(f.events.filter(event => event === "execute-verify").length, 0);
  }
});

test("automatic readonly verification permission is not forged into native approval after policy changes", async t => {
  const f = await fixture(t, { autoVerify: true, afterWrite: async state => { state.always = true; } });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new\n", verify_command: "check" }), { code: "DENIED" });
  assert.equal(f.events.filter(event => event === "execute-verify").length, 0);
  assert.equal(f.gateCalls.find(call => call.options.command).options.approvedOnce, false);
});

test("successful write gate is after final file version read; verification gate is immediately before exec", async t => {
  const f = await fixture(t);
  const value = await f.run("remote_write", { path: "/etc/demo", content: "new\n", verify_command: "check" });
  assert.equal(value.verification.status, "passed");
  assert.deepEqual(f.events, ["stat", "read", "approve-write", "approve-verify", "stat", "read", "gate-write", "write", "stat", "read", "gate-verify", "execute-verify"]);
  assert.equal(f.gateCalls[0].options.approvedOnce, true);
  assert.equal(f.gateCalls[1].options.approvedOnce, true);
  assert.equal(f.gateCalls[0].snapshot, f.gateCalls[1].snapshot);
  assert.equal(Object.isFrozen(f.gateCalls[0].snapshot), true);
  assert.ok(!JSON.stringify(value).includes("private-gate-state"));
  assert.ok(!JSON.stringify(value).includes("guardContext"));
  const backup = await readFile(join(f.root, `${value.backupId}.json`), "utf8");
  assert.doesNotMatch(backup, /private-gate-state|expectedChecksHash|expectedConnectionDigest|guardContext/);
});

test("restore captures its own gate snapshot and rejects guard activation before a second write", async t => {
  let restoring = false;
  const f = await fixture(t, { onAuthorize: async (_request, state) => { if (restoring) state.checks = "new-checks"; } });
  const changed = await f.run("remote_write", { path: "/etc/demo", content: "new\n" });
  restoring = true;
  await assert.rejects(f.run("remote_restore", { backup_id: changed.backupId }), error => error.code === "TARGET_SFTP_UNSUPPORTED" && error.change.writeAttempted === false);
  assert.equal(f.events.filter(event => event === "write").length, 1);
  assert.equal(f.files.get("/etc/demo").toString(), "new\n");
});
