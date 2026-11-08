import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTools } from "../../lib/tools.js";

async function harness(t, overrides = {}) {
  const backupRoot = await mkdtemp(join(tmpdir(), "dsh-file-tools-"));
  t.after(() => rm(backupRoot, { recursive: true, force: true }));
  const host = { id: "config:demo", name: "demo", host: "192.0.2.10", username: "ops" };
  const files = new Map([["/etc/demo", { content: Buffer.from("port=80\n"), mode: 0o600, uid: 50, gid: 51 }]]);
  const calls = [];
  const transport = {
    async homeDir() { return "/home/ops"; },
    async stat(h, p) { const f = files.get(p); if (!f) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { type: "file", size: f.content.length, ...f }; },
    async readFile(h, p) { return { content: files.get(p).content, truncated: false }; },
    async writeFile(h, p, content, options) {
      calls.push({ kind: "write", path: p, options });
      files.set(p, { content: Buffer.from(content), mode: options.mode ?? 0o644, uid: options.uid ?? 50, gid: options.gid ?? 51 });
      return { bytesWritten: content.length };
    },
    async exec(h, options) { calls.push({ kind: "exec", options }); return overrides.execResult ?? { code: 0, timedOut: false }; },
  };
  const approval = {
    assessCommand(command) { return command.includes("forbidden") ? { level: "high", denied: "forbidden" } : { level: "gray", verb: "custom" }; },
    async authorize(request) {
      calls.push({ kind: "approve", request });
      if (overrides.authorize) return overrides.authorize(request, files);
      return { allowed: !request.readonlyHost };
    },
  };
  const tools = createTools({ defineTool: d => d, config: {}, transport, backupRoot, approval, logger: overrides.logger,
    hosts: { find: async () => host, isAllowed: () => true, isReadonly: () => overrides.readonly ?? false }, cwdOf: async () => backupRoot });
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  const exec = { agent: { id: "agent-demo" }, callId: "call-demo", signal: new AbortController().signal };
  const run = (name, args) => byName[name].execute({ host: "demo", ...args }, exec);
  return { calls, files, run, byName };
}

test("write/edit/restore tools round-trip metadata and approve each Diff", async t => {
  const f = await harness(t);
  const changed = await f.run("remote_edit", { path: "/etc/demo", old_string: "80", new_string: "8080" });
  assert.equal(changed.replacements, 1);
  assert.ok(changed.backupId);
  assert.match(f.calls[0].request.preview, /-port=80/);
  const restored = await f.run("remote_restore", { backup_id: changed.backupId });
  assert.equal(f.files.get("/etc/demo").content.toString(), "port=80\n");
  assert.equal(f.files.get("/etc/demo").uid, 50);
  assert.equal(restored.afterVersion, changed.beforeVersion);
  assert.ok(f.calls.some(c => c.request?.toolName === "remote_restore" && c.request.preview));
});

test("verification denied before mutation; unknown command independently reviewed", async t => {
  const denied = await harness(t);
  await assert.rejects(denied.run("remote_write", { path: "/etc/demo", content: "new", verify_command: "forbidden-check" }), { code: "DENIED" });
  assert.equal(denied.calls.filter(c => c.kind === "write").length, 0);
  const f = await harness(t);
  const value = await f.run("remote_write", { path: "/etc/demo", content: "new", verify_command: "custom-check", verify_timeout_ms: 500 });
  assert.equal(value.verification.status, "passed");
  assert.deepEqual(f.calls.map(c => c.kind), ["approve", "approve", "write", "exec"]);
  const verificationApproval = f.calls[1].request;
  assert.equal(verificationApproval.unproven, true);
  assert.equal(verificationApproval.subject, "custom-check");
  assert.equal(f.calls[3].options.timeoutMs, 500);
  assert.ok(f.calls[3].options.signal);
});

test("verification timeout returns truthful failure and leaves changed file without reload", async t => {
  const f = await harness(t, { execResult: { code: -1, timedOut: true } });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new", verify_command: "check" }), e => e.code === "VERIFICATION_TIMEOUT" && e.change.verification.status === "timed_out" && Boolean(e.change.backupId));
  assert.equal(f.calls.filter(c => c.kind === "exec").length, 1);
  assert.equal(f.files.get("/etc/demo").content.toString(), "new");
});

test("readonly and restore denials never write", async t => {
  const f = await harness(t, { readonly: true });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new" }), { code: "DENIED" });
  assert.equal(f.calls.filter(c => c.kind === "write").length, 0);
  let denyRestore = false;
  const r = await harness(t, { authorize: async request => ({ allowed: !(denyRestore && request.toolName === "remote_restore") }) });
  const changed = await r.run("remote_write", { path: "/etc/demo", content: "new" });
  denyRestore = true;
  await assert.rejects(r.run("remote_restore", { backup_id: changed.backupId }), { code: "DENIED" });
  assert.equal(r.calls.filter(c => c.kind === "write").length, 1);
});

test("exact replacement treats dollar syntax literally and rejects lossy binary edits", async t => {
  const f = await harness(t);
  await f.run("remote_edit", { path: "/etc/demo", old_string: "80", new_string: "$&" });
  assert.equal(f.files.get("/etc/demo").content.toString(), "port=$&\n");
  f.files.get("/etc/demo").content = Buffer.from([0xff, 0x61]);
  await assert.rejects(f.run("remote_edit", { path: "/etc/demo", old_string: "a", new_string: "b" }), /valid UTF-8/);
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "replacement" }), { code: "INVALID_UTF8" });
});

test("signal-bearing verification is unknown even with a contradictory zero exit code", async t => {
  const f = await harness(t, { execResult: { code: 0, signal: "TERM", timedOut: false } });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new", verify_command: "check" }), error => {
    assert.equal(error.change.verification.status, "unknown");
    return true;
  });
  assert.equal(f.calls.filter(c => c.kind === "exec").length, 1);
});

test("denial logger never records approval Diff or secrets", async t => {
  const warnings = [];
  const f = await harness(t, { logger: { warn: message => warnings.push(message) },
    authorize: async request => ({ allowed: false, outcome: "rejected", reason: `Rejected: ${request.preview}` }) });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "password=private-token" }), { code: "DENIED" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /remote_write denied on demo; outcome=rejected/);
  assert.doesNotMatch(warnings[0], /port=80|password|private-token|Diff/);
});

test("post-write failures expose recovery backup ID in their message", async t => {
  const f = await harness(t, { execResult: { code: 1, timedOut: false } });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new", verify_command: "check" }), e => {
    assert.match(e.message, new RegExp(`backupId=${e.change.backupId}`));
    assert.match(e.message, /afterVersion=[a-f0-9]{64}/);
    assert.doesNotMatch(e.message, /port=80/);
    return true;
  });
});

test("relative targets normalize to absolute SFTP home and size limit remains enforced", async t => {
  const f = await harness(t);
  const created = await f.run("remote_write", { path: "./demo", content: "new" });
  assert.equal(created.path, "/home/ops/demo");
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "x".repeat(800001) }), { code: "FILE_TOO_LARGE" });
  await assert.rejects(f.run("remote_write", { path: "/etc/demo", content: "new", verify_command: " " }), /non-empty/);
});
