import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeConnectionProfile } from "../../lib/connection-profile.js";
import { Config, normalizeConfig } from "../../lib/config.js";
import { createHostRegistry } from "../../lib/host-registry.js";
import { loadHosts, findHost, isHostAllowed, isHostReadonly } from "../../lib/hosts.js";
import { remoteHostOf } from "../../lib/api-helpers.js";

const profile = { viaHost: "bastion-demo", loginCommand: "sww -r -u demo.user cluster-a" };
const shortcut = { name: "cluster-a", ...profile, tags: ["cluster"], description: "Cluster terminal" };
const migrated = { viaHost: "bastion-demo", actions: [{ type: "command", value: profile.loginCommand, expectCluster: "cluster-a" }] };

test("profile accepts only the bounded sww grammar and canonicalizes ASCII spaces", () => {
  assert.deepEqual(normalizeConnectionProfile({}), {});
  assert.deepEqual(normalizeConnectionProfile({ ...profile, loginCommand: " sww  -r -u  demo.user cluster-a " }), migrated);
  const invalidCommands = ["hostname", "sww -u x -r z", "sww -r -u -x z", "sww -r -u x --help", "sww -r -u x z extra", "sww -r -u x z;id", "sww -r -u x z\nid", "sww -r -u x z\n", "sww\t-r -u x z", "sww -r -u $(id) z", "sww -r -u x `id`", "sww -r -u x 'z'", "sww -r -u x z|id", "sww -r -u x z&", "sww -r -u x z>file", "sww -r -u x z\\", "sww -r -u x z\0", `sww -r -u ${"a".repeat(65)} z`];
  for (const loginCommand of invalidCommands) assert.throws(() => normalizeConnectionProfile({ ...profile, loginCommand }), { code: "HOST_INVALID" });
  for (const input of [null, [], "", { viaHost: "bastion-demo" }, { loginCommand: profile.loginCommand }, { ...profile, viaHost: "bastion-demo\n" }, { ...profile, viaHost: "-x" }, { ...profile, viaHost: "x;id" }, { ...profile, viaHost: null }, { ...profile, loginCommand: null }]) {
    assert.throws(() => normalizeConnectionProfile(input), { code: "HOST_INVALID" });
  }
});

test("configuration accepts address-less shortcuts and stays idempotent", () => {
  const parsed = normalizeConfig(Config({ hosts: [shortcut], includeSshConfig: false }));
  assert.equal(parsed.hosts[0].host, undefined);
  assert.deepEqual(parsed.hosts[0].actions, migrated.actions);
  assert.equal(parsed.hosts[0].loginCommand, undefined);
  assert.deepEqual(normalizeConfig(parsed), parsed);
  assert.throws(() => normalizeConfig({ hosts: [{ name: "x", viaHost: "bastion-demo" }] }), /viaHost|loginCommand/);
  assert.throws(() => Config({ hosts: [{ name: "x" }] }));
});

test("shortcut inherits all entrance SSH flags but retains metadata and policies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-profile-"));
  try {
    const sshConfigPath = join(dir, "config");
    await writeFile(sshConfigPath, "Host bastion-demo\n HostName 192.0.2.1\n User ops\n Port 2222\n IdentityFile ~/.ssh/id\n ProxyJump jump\n PubkeyAuthentication no\n PasswordAuthentication yes\n KbdInteractiveAuthentication no\n");
    const config = { sshConfigPath, hosts: [shortcut], readonlyHosts: ["BASTION-DEMO"] };
    const hosts = await loadHosts(config);
    const host = findHost(hosts, "cluster-a");
    assert.equal(host.host, "192.0.2.1");
    assert.equal(host.port, 2222);
    assert.equal(host.username, "ops");
    assert.equal(host.identityFile, "~/.ssh/id");
    assert.deepEqual(host.proxyJump, ["jump"]);
    assert.equal(host.pubkeyAuthentication, false);
    assert.equal(host.passwordAuthentication, true);
    assert.equal(host.keyboardInteractiveAuthentication, false);
    assert.equal(host.id, "config:cluster-a");
    assert.equal(host.source, "config");
    assert.deepEqual(host.tags, shortcut.tags);
    assert.equal(host.description, shortcut.description);
    assert.equal(host.readonly, true);
    assert.equal(isHostAllowed(host, { allowHosts: ["cluster-a"] }), false);
    assert.equal(isHostAllowed(host, { allowHosts: ["bastion-demo"] }), false);
    assert.equal(isHostAllowed(host, { allowHosts: ["cluster-a", "BASTION-DEMO"] }), true);
    assert.equal(isHostReadonly({ ...host, readonly: false }, { readonlyHosts: ["bastion-demo"] }), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("managed entrance auth is inherited, managed shortcut wins collisions", async () => {
  const hosts = await loadHosts({ includeSshConfig: false, hosts: [{ name: "bastion-demo", host: "entry", passwordEnv: "PW", passphraseEnv: "KEY_PW", identityFile: "key" }, { name: "cluster-a", host: "shadowed" }] }, { registryHosts: [shortcut] });
  const host = findHost(hosts, "cluster-a");
  assert.equal(host.host, "entry");
  assert.equal(host.passwordEnv, "PW");
  assert.equal(host.passphraseEnv, "KEY_PW");
  assert.equal(host.managed, true);
  assert.equal(host.source, "managed");
});

test("missing entrances, cycles and nested shortcuts cannot resolve", async () => {
  for (const hosts of [[shortcut], [{ ...shortcut, viaHost: "cluster-a" }], [shortcut, { name: "bastion-demo", viaHost: "cluster-a", loginCommand: "sww -r -u x other" }], [shortcut, { name: "bastion-demo", viaHost: "entry", loginCommand: "sww -r -u x other" }, { name: "entry", host: "entry" }]]) {
    await assert.rejects(loadHosts({ includeSshConfig: false, hosts }), /viaHost/);
  }
  const warnings = [];
  assert.deepEqual(await loadHosts({ includeSshConfig: false }, { registryHosts: [shortcut], logger: { warn: (text) => warnings.push(text) } }), []);
  assert.equal(warnings.length, 1);
});

test("registry persists, reloads and updates shortcuts without SSH address", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-profile-registry-"));
  try {
    const filePath = join(dir, "hosts.json");
    const registry = createHostRegistry({ filePath });
    await registry.create(shortcut);
    const stored = JSON.parse(await readFile(filePath, "utf8")).hosts[0];
    assert.equal(stored.host, undefined);
    assert.equal(stored.viaHost, "bastion-demo");
    const loaded = await createHostRegistry({ filePath }).load();
    assert.deepEqual(loaded[0].actions, migrated.actions);
    assert.equal(loaded[0].loginCommand, undefined);
    const updated = await registry.update("cluster-a", { ...shortcut, loginCommand: "sww -r -u ops other" });
    assert.deepEqual(updated.actions, [{ type: "command", value: "sww -r -u ops other", expectCluster: "other" }]);
    await assert.rejects(registry.create({ name: "bad", viaHost: "bastion-demo", loginCommand: "id" }), { code: "HOST_INVALID" });
    await assert.rejects(registry.create({ ...shortcut, name: "bastion-demo" }), { code: "HOST_INVALID" });
    const fallback = remoteHostOf(updated);
    assert.equal(fallback.viaHost, "bastion-demo");
    assert.deepEqual(fallback.actions, updated.actions);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
