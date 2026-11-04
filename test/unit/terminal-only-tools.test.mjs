import assert from "node:assert/strict";
import test from "node:test";
import { createTools } from "../../lib/tools.js";
import { createShellManager } from "../../lib/terminal/manager.js";
const host = { name: "cluster-a", host: "192.0.2.10", viaHost: "bastion-demo", loginCommand: "sww -r -u demo.user cluster-a", source: "managed" };
const hosts = { find: async () => host, list: async () => [host], isAllowed: () => true, isReadonly: () => false };

test("all one-shot and SFTP tools reject terminal-only hosts before invoking transport", async () => {
  let called = 0;
  const tools = createTools({ defineTool: d => d, config: {}, hosts, approval: {}, transport: new Proxy({}, { get() { return () => { called++; }; } }), cwdOf: async () => process.cwd() });
  for (const tool of tools.filter(t => t.name !== "remote_hosts")) {
    await assert.rejects(tool.execute({ host: "cluster-a", command: "hostname", path: "/tmp", local_path: "x", remote_path: "x", direction: "upload" }, { agent: {}, signal: new AbortController().signal }), { code: "TERMINAL_ONLY_HOST" });
  }
  assert.equal(called, 0);
  const listing = await tools.find(t => t.name === "remote_hosts").execute({}, {});
  assert.equal(listing.hosts[0].terminalOnly, true);
  assert.match(listing.hosts[0].description, /terminal-only via bastion-demo/);
});

test("a shortcut cannot fall back to an uninitialized standalone shell", async () => {
  let called = 0;
  const manager = createShellManager({ transport: { openPty: async () => { called++; } } });
  await assert.rejects(manager.open({ agent: {}, host }), { code: "SHARED_PTY_REQUIRED" });
  assert.equal(called, 0);
  await manager.dispose();
});
