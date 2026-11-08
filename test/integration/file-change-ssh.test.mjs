import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTools } from "../../lib/tools.js";
import { createSshTransport } from "../../lib/ssh/transport.js";
import { startSshServer } from "../fixtures/ssh-server.mjs";

// Isolated loopback SSH fixture only. Never reads live inventory or contacts real hosts.
test("safe change and restore preserve real SFTP mode/uid/gid, reject symlinks, and verify once", async t => {
  const server = await startSshServer();
  const root = await mkdtemp(join(tmpdir(), "dsh-safe-ssh-"));
  const transport = createSshTransport({ knownHostsPolicy: "tofu", knownHostsPath: join(root, "known-hosts.json") });
  t.after(async () => { await transport.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const path = join(server.rootDir, "demo.conf");
  await writeFile(path, "port=80\n");
  await chmod(path, 0o640);
  const original = await stat(path);
  const host = { id: "config:fixture", name: "fixture", host: server.host, port: server.port,
    username: server.username, identityFile: server.privateKeyPath };
  const approvals = [];
  const tools = createTools({ defineTool: definition => definition, config: {}, transport,
    backupRoot: join(root, "backups"), cwdOf: async () => root,
    hosts: { find: async () => host, isAllowed: () => true, isReadonly: () => false },
    approval: { assessCommand: () => ({ level: "low", verb: "test" }), authorize: async r => { approvals.push(r); return { allowed: true }; } } });
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  const exec = { signal: new AbortController().signal, callId: "fixture-call", agent: { id: "fixture-agent" } };
  const changed = await byName.remote_edit.execute({ host: "fixture", path, old_string: "80", new_string: "8080", verify_command: "test -f demo.conf" }, exec);
  assert.ok(changed.backupId);
  assert.equal(changed.verification.status, "passed");
  const after = await stat(path);
  assert.equal(after.mode, original.mode);
  assert.equal(after.uid, original.uid);
  assert.equal(after.gid, original.gid);
  assert.equal(await readFile(path, "utf8"), "port=8080\n");
  assert.equal(server.execCommands.filter(command => command.includes("test -f demo.conf")).length, 1);
  assert.match(approvals[0].preview, /-port=80/);
  const restored = await byName.remote_restore.execute({ host: "fixture", backup_id: changed.backupId }, exec);
  assert.equal(restored.afterVersion, changed.beforeVersion);
  assert.equal(await readFile(path, "utf8"), "port=80\n");
  await symlink(path, join(server.rootDir, "link.conf"));
  await assert.rejects(byName.remote_write.execute({ host: "fixture", path: join(server.rootDir, "link.conf"), content: "unsafe" }, exec), { code: "UNSAFE_FILE_TYPE" });
  assert.equal(await readFile(path, "utf8"), "port=80\n");
});
