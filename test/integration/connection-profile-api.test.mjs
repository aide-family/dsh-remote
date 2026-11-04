import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementApi } from "../../lib/api.js";
import { createHostRegistry } from "../../lib/host-registry.js";
import { createHostStore } from "../../lib/host-store.js";
import { createAuditLog } from "../../lib/audit.js";
import { normalizeConfig } from "../../lib/config.js";

// Exercise the real registry -> resolution -> HTTP HostView, not a fake shortcut mapper.
test("management API persists a shortcut, exposes profile metadata and never probes its entrance", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-profile-api-"));
  const registry = createHostRegistry({ filePath: join(dir, "hosts.json") });
  const config = normalizeConfig({ includeSshConfig: false, hosts: [{ name: "bastion-demo", host: "192.0.2.10", username: "demo.user/198.51.100.17/self" }] });
  const hosts = createHostStore({ config, registry });
  let transportCalls = 0;
  const transport = { test() { transportCalls++; }, exec() { transportCalls++; } };
  const server = createServer(createManagementApi({
    ctx: { get: name => name === "connection" ? { requestRejection: () => undefined } : undefined },
    config, hosts, registry, transport, audit: createAuditLog({ limit: 50 }),
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const call = async (method, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-remote/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, ...args }) });
    return { status: response.status, body: await response.json() };
  };
  const profile = { name: "cluster-a", viaHost: "bastion-demo", loginCommand: "sww -r -u demo.user cluster-a", tags: ["cluster"] };
  const created = await call("host.create", { host: profile });
  assert.equal(created.body.ok, true);
  assert.equal(created.body.result.host.viaHost, "bastion-demo");
  assert.equal(created.body.result.host.terminalOnly, true);
  assert.equal(created.body.result.host.username, "demo.user/198.51.100.17/self");
  const overview = await call("overview");
  const migrated = overview.body.result.hosts.find(h => h.name === "cluster-a");
  assert.equal(migrated.loginCommand, undefined);
  assert.deepEqual(migrated.actions, [{ type: "command", value: profile.loginCommand, expectCluster: "cluster-a" }]);
  const probed = await call("host.test", { name: "cluster-a" });
  assert.equal(probed.status, 409);
  assert.equal(probed.body.error.code, "TERMINAL_ONLY_HOST");
  assert.equal(transportCalls, 0);
  const reloaded = createHostRegistry({ filePath: join(dir, "hosts.json") });
  await reloaded.load();
  assert.equal(reloaded.get("cluster-a").viaHost, "bastion-demo");
  assert.equal(reloaded.get("cluster-a").host, undefined);
  const actions = [
    { type: "command", value: "switch-cluster target", expect: "Target ready", timeoutMs: 5000 },
    { type: "text", value: "option-1" },
    { type: "key", value: "Enter" },
    { type: "wait", value: "Root shell ready", timeoutMs: 2000 },
    { type: "delay", durationMs: 100 },
  ];
  const changed = await call("host.update", { name: "cluster-a", host: { name: "cluster-a", viaHost: "bastion-demo", actions } });
  assert.equal(changed.body.ok, true);
  assert.deepEqual(changed.body.result.host.actions, actions);
  assert.equal(changed.body.result.host.loginCommand, undefined);
  const changedReload = createHostRegistry({ filePath: join(dir, "hosts.json") });
  await changedReload.load();
  assert.deepEqual(changedReload.get("cluster-a").actions, actions);
  const getCopy = registry.get("cluster-a");
  getCopy.actions[0].value = "tampered";
  const listCopy = registry.list();
  listCopy[0].actions.reverse();
  assert.deepEqual(registry.get("cluster-a").actions, actions, "get/list actions are defensive copies");
  const rejected = await call("host.update", { name: "cluster-a", host: { name: "cluster-a", viaHost: "bastion-demo", actions: [{ type: "text", value: "secret", password: "must-not-be-saved" }] } });
  assert.equal(rejected.body.ok, false);
  assert.deepEqual(registry.get("cluster-a").actions, actions, "invalid update leaves actions unchanged");
  const updated = await call("host.update", { name: "cluster-a", host: { name: "cluster-a", host: "10.0.0.8", username: "root" } });
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.result.host.viaHost, undefined);
  assert.equal(registry.get("cluster-a").loginCommand, undefined);
  assert.equal(registry.get("cluster-a").actions, undefined);
});
