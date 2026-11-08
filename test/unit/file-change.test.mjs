import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileChanges, changePreview, fileVersion } from "../../lib/file-change.js";
import { serializeTarget } from "../../lib/file-change-store.js";

const host = { id: "config:fixture", name: "fixture", host: "192.0.2.1", username: "ops" };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-file-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([["/etc/demo", { content: Buffer.from("old\n"), mode: 0o640, uid: 42, gid: 43 }]]);
  const calls = [];
  const exec = { signal: new AbortController().signal };
  const transport = {
    async stat(h, p, o) {
      o.signal?.throwIfAborted();
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { ...f, type: f.type ?? "file", size: f.content.length };
    },
    async readFile(h, p, o) {
      o.signal?.throwIfAborted();
      const content = files.get(p).content;
      return { content: content.subarray(0, o.maxBytes), truncated: content.length > o.maxBytes };
    },
    async writeFile(h, p, content, o) {
      calls.push({ kind: "write", p, options: o });
      if (options.writeError) throw options.writeError;
      files.set(p, { content: Buffer.from(content), mode: o.mode ?? 0o644, uid: o.uid ?? 42, gid: o.gid ?? 43 });
      return { bytesWritten: content.length };
    },
  };
  const changes = createFileChanges({ transport, backupRoot: options.noBackup ? undefined : root, maxReadBytes: options.maxBytes ?? 800000,
    async authorize(request) { calls.push({ kind: "approve", ...request }); if (options.authorize) await options.authorize(request, files); },
    async verify(request) { calls.push({ kind: request.authorizeOnly ? "approve-verify" : "verify" }); return options.verify ? options.verify(request) : { status: "passed", exitCode: 0, timedOut: false }; },
  });
  const apply = (extra = {}) => changes.change({ host, path: "/etc/demo", exec, toolName: "remote_write", transform: () => ({ content: Buffer.from("new\n") }), ...extra });
  return { root, files, calls, exec, changes, apply, transport };
}

test("durable backup, metadata, Diff and restart restore with another recovery backup", async (t) => {
  const f = await fixture(t);
  const value = await f.apply();
  assert.match(value.backupId, /^[0-9a-f-]{36}$/);
  assert.equal(value.beforeVersion, fileVersion({ content: Buffer.from("old\n"), mode: 0o640, uid: 42, gid: 43 }));
  assert.notEqual(value.beforeVersion, value.afterVersion);
  assert.match(f.calls[0].preview, /-old\n[\s\S]*\+new/);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  const backupPath = join(f.root, `${value.backupId}.json`);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(backupPath, "utf8"));
  assert.equal(Buffer.from(record.content, "base64").toString(), "old\n");
  assert.equal(record.uid, 42);
  const restarted = createFileChanges({ transport: f.transport, backupRoot: f.root, maxReadBytes: 800000, authorize: async () => {}, verify: async () => {} });
  const restored = await restarted.restore({ host, backupId: value.backupId, exec: f.exec });
  assert.equal(f.files.get("/etc/demo").content.toString(), "old\n");
  assert.notEqual(restored.backupId, value.backupId);
  assert.equal(restored.afterVersion, value.beforeVersion);
});

test("approval mutation conflicts cause no write and return recovery facts", async (t) => {
  const f = await fixture(t, { authorize: async (_, files) => { files.get("/etc/demo").content = Buffer.from("external"); } });
  await assert.rejects(f.apply(), (e) => e.code === "VERSION_CONFLICT" && e.change.backupId && e.change.writeAttempted === false);
  assert.equal(f.calls.filter(c => c.kind === "write").length, 0);
});

test("denial does not persist backup or mutate", async (t) => {
  const f = await fixture(t, { authorize: async () => { throw Object.assign(new Error("denied"), { code: "DENIED" }); } });
  await assert.rejects(f.apply(), { code: "DENIED" });
  assert.equal((await readdir(f.root)).length, 0);
  assert.equal(f.files.get("/etc/demo").content.toString(), "old\n");
});

test("backup is required for overwrite; new-file restore is not a deletion", async (t) => {
  const missing = await fixture(t, { noBackup: true });
  await assert.rejects(missing.apply(), { code: "BACKUP_UNAVAILABLE" });
  assert.equal(missing.calls.filter(c => c.kind === "write").length, 0);
  const f = await fixture(t);
  const created = await f.apply({ path: "/etc/new" });
  await assert.rejects(f.changes.restore({ host, backupId: created.backupId, exec: f.exec }), { code: "NO_ORIGINAL_FILE" });
  assert.equal(f.files.has("/etc/new"), true);
});

test("restore rejects path traversal IDs, wrong host and external changes", async (t) => {
  const f = await fixture(t);
  const changed = await f.apply();
  await assert.rejects(f.changes.restore({ host, backupId: "../../secret", exec: f.exec }), /Invalid backup_id/);
  await assert.rejects(f.changes.restore({ host: { ...host, host: "192.0.2.2" }, backupId: changed.backupId, exec: f.exec }), { code: "BACKUP_HOST_MISMATCH" });
  f.files.get("/etc/demo").content = Buffer.from("external");
  await assert.rejects(f.changes.restore({ host, backupId: changed.backupId, exec: f.exec }), { code: "VERSION_CONFLICT" });
});

test("symlink targets and oversized files/changes are refused", async (t) => {
  const f = await fixture(t, { maxBytes: 4 });
  f.files.get("/etc/demo").type = "symlink";
  await assert.rejects(f.apply(), { code: "UNSAFE_FILE_TYPE" });
  f.files.get("/etc/demo").type = "file";
  await assert.rejects(f.apply({ transform: () => ({ content: Buffer.from("12345") }) }), { code: "FILE_TOO_LARGE" });
  f.files.get("/etc/demo").content = Buffer.from("12345");
  await assert.rejects(f.apply(), { code: "FILE_TOO_LARGE" });
});

test("verification is authorized before write, runs once, and failed validation preserves recovery", async (t) => {
  const f = await fixture(t, { verify: async (r) => r.authorizeOnly ? undefined : { status: "failed", exitCode: 1, timedOut: false } });
  await assert.rejects(f.apply({ verifyCommand: "fixture-check", verifyTimeout: 100 }), e => e.code === "VERIFICATION_FAILED" && e.change.afterVersion && e.change.verification.exitCode === 1);
  assert.deepEqual(f.calls.map(c => c.kind), ["approve", "approve-verify", "write", "verify"]);
  assert.equal(f.files.get("/etc/demo").content.toString(), "new\n");
});

test("unknown write outcome includes backup and never blindly retries", async (t) => {
  const f = await fixture(t, { writeError: Object.assign(new Error("lost connection"), { code: "CONNECTION" }) });
  await assert.rejects(f.apply(), e => e.change.backupId && e.change.writeAttempted && e.change.afterVersion === null);
  assert.equal(f.calls.filter(c => c.kind === "write").length, 1);
});

test("same target writes are serialized across tool instances and approval snapshots", async (t) => {
  let release;
  const barrier = new Promise(r => { release = r; });
  let first = true;
  const f = await fixture(t, { authorize: async () => { if (first) { first = false; await barrier; } } });
  const secondInstance = createFileChanges({ transport: f.transport, backupRoot: f.root, maxReadBytes: 800000, authorize: async () => {}, verify: async () => {} });
  const one = f.apply();
  const two = secondInstance.change({ host: { ...host, name: "fixture-alias", id: "config:alias" }, path: "/etc/demo", exec: f.exec, toolName: "remote_write", transform: () => ({ content: Buffer.from("last") }) });
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(b.beforeVersion, a.afterVersion);
  assert.equal(f.files.get("/etc/demo").content.toString(), "last");
});

test("abort before write and verification cancellation do not perform extra mutations", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.apply({ exec: { signal: controller.signal } }), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
  const cancelled = await fixture(t, { verify: async r => { if (!r.authorizeOnly) throw Object.assign(new Error("cancel"), { name: "AbortError" }); } });
  await assert.rejects(cancelled.apply({ verifyCommand: "check" }), e => e.name === "AbortError" && e.change.verification.status === "cancelled");
});

test("backup file symlink cannot be used to load outside the store", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  await writeFile(join(f.root, "outside"), "{}");
  await symlink(join(f.root, "outside"), join(f.root, `${id}.json`));
  await assert.rejects(f.changes.restore({ host, backupId: id, exec: f.exec }));
});

test("queued abort settles promptly without letting another writer bypass the active lock", async () => {
  let release;
  let entered;
  const started = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  const one = serializeTarget("queued-abort-test", async () => { entered(); await barrier; });
  await started;
  const controller = new AbortController();
  const two = serializeTarget("queued-abort-test", async () => { throw new Error("must not execute"); }, controller.signal);
  controller.abort();
  await assert.rejects(two, { name: "AbortError" });
  let thirdEntered = false;
  const three = serializeTarget("queued-abort-test", async () => { thirdEntered = true; });
  await Promise.resolve();
  assert.equal(thirdEntered, false);
  release();
  await Promise.all([one, three]);
  assert.equal(thirdEntered, true);
});

test("restore rejects corrupt content and invalid metadata before approval", async t => {
  const f = await fixture(t);
  const changed = await f.apply();
  const path = join(f.root, `${changed.backupId}.json`);
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const corrupted of [{ ...original, content: Buffer.from("corrupt").toString("base64") }, { ...original, uid: -1 }, { ...original, mode: "640" }]) {
    await writeFile(path, JSON.stringify(corrupted));
    const approvalsBefore = f.calls.filter(c => c.kind === "approve").length;
    await assert.rejects(f.changes.restore({ host, backupId: changed.backupId, exec: f.exec }), { code: "INVALID_BACKUP" });
    assert.equal(f.calls.filter(c => c.kind === "approve").length, approvalsBefore);
    assert.equal(f.files.get("/etc/demo").content.toString(), "new\n");
  }
});

test("Diff excludes far-away unchanged credentials and has contextual hunk header", () => {
  const before = ["unchanged-secret=password", ...Array.from({ length: 10 }, (_, i) => `line-${i}`), "old", ...Array.from({ length: 10 }, (_, i) => `tail-${i}`), "far-away-token=secret"].join("\n");
  const after = before.replace("\nold\n", "\nnew\n");
  const preview = changePreview("/etc/demo", Buffer.from(before), Buffer.from(after));
  assert.match(preview, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(preview, /-old\n\+new\n/);
  assert.doesNotMatch(preview, /unchanged-secret|far-away-token/);
});

test("Diff is bounded with explicit truncation", () => {
  const preview = changePreview("/tmp/demo", Buffer.from("old"), Buffer.from("x".repeat(100000)));
  assert.ok(Buffer.byteLength(preview) < 50 * 1024);
  assert.match(preview, /Diff truncated/);
  const removal = changePreview("/tmp/demo", Buffer.from("x".repeat(100000)), Buffer.from("new-value"));
  assert.match(removal, /\+new-value/);
  assert.match(removal, /Removed lines truncated/);
});
