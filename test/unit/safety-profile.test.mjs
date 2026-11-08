import assert from "node:assert/strict";
import test from "node:test";
import { Config, normalizeConfig } from "../../lib/config.js";
import { normalizeSafetyProfiles, resolveSafetyProfile } from "../../lib/safety-profile.js";
import { createApprovalGate, MAX_APPROVAL_SUBJECT_BYTES, MAX_APPROVAL_PREVIEW_BYTES } from "../../lib/approval.js";
import { authorizeConnectionLogin } from "../../lib/terminal/connection-login.js";
import { isHostReadonly, loadHosts } from "../../lib/hosts.js";

const HOST = { name: "prod-web-1", host: "192.0.2.11", username: "ops", port: 2222, tags: ["web", "prod"] };
const EXEC = { agent: { id: "agent-policy" }, callId: "call-policy", signal: new AbortController().signal };
function gate(raw = {}, outcome = "allowed-once") {
  const requests = [];
  const config = normalizeConfig({ includeSshConfig: false, ...raw });
  const approval = createApprovalGate({ config, ctx: { get: () => ({ request: async (request) => { requests.push(request); return outcome; } }) } });
  return { approval, requests, config };
}
const operation = (extra = {}) => ({ toolName: "remote_exec", exec: EXEC, host: HOST, action: "execute", subject: "mystery-tool --inspect", mutating: false, ...extra });

test("profile readonly is truthfully reflected in inventory and entrance shortcuts", async () => {
  const config = normalizeConfig({ includeSshConfig: false,
    hosts: [{ name: "entry", host: "192.0.2.11", tags: ["prod"] }, { name: "shortcut", viaHost: "entry", actions: [{ type: "command", value: "hostname" }] }],
    profiles: [{ name: "protected", tags: ["prod"], readonly: true }] });
  const hosts = await loadHosts(config);
  assert.ok(hosts.every(host => host.readonly === true && isHostReadonly(host, config)));
});

test("profiles match name globs or any exact tag; glob regex punctuation is literal", () => {
  const config = normalizeConfig({ profiles: [
    { name: "names", hosts: ["PROD-web-?"] },
    { name: "tags", hosts: ["other-*"], tags: ["prod"] },
    { name: "literal", hosts: ["prod.web-*"] },
    { name: "tag-exact", tags: ["pr*"] },
  ] });
  assert.deepEqual(resolveSafetyProfile(config, HOST).profiles, ["names", "tags"]);
  assert.deepEqual(resolveSafetyProfile(config, { name: "prod.web-2" }).profiles, ["literal"]);
});

test("all matched profiles compose restrictively and order independently", () => {
  const profiles = [
    { name: "prod", tags: ["prod"], environment: "production", unprovenCommands: "allow", impact: "web availability" },
    { name: "strict", hosts: ["prod-*"], policy: "always", readonly: true, denyCommandPatterns: ["reboot"] },
    { name: "loose", hosts: ["*"], policy: "auto", readonly: false, unprovenCommands: "allow" },
  ];
  for (const ordered of [profiles, [...profiles].reverse()]) {
    const resolved = resolveSafetyProfile(normalizeConfig({ profiles: ordered, denyCommandPatterns: ["shutdown"] }), HOST);
    assert.equal(resolved.policy, "always");
    assert.equal(resolved.readonly, true);
    assert.equal(resolved.unprovenCommands, "ask");
    assert.deepEqual(new Set(resolved.denyCommandPatterns), new Set(["shutdown", "reboot"]));
  }
});

test("profiles cannot loosen global never, readonly, deny or unknown ask", () => {
  const config = normalizeConfig({ policy: "never", readonlyHosts: ["prod-*"], denyCommandPatterns: ["shutdown"], unprovenCommands: "ask",
    profiles: [{ name: "loose", tags: ["prod"], policy: "auto", readonly: false, unprovenCommands: "allow" }] });
  const resolved = resolveSafetyProfile(config, HOST);
  assert.equal(resolved.policy, "never");
  assert.equal(resolved.readonly, true);
  assert.equal(resolved.unprovenCommands, "ask");
  assert.deepEqual(resolved.denyCommandPatterns, ["shutdown"]);
});

test("production labels force unknown ask; absent profiles preserve global default", async () => {
  for (const environment of ["prod", "production", "PRODUCTION"]) {
    const { approval, requests } = gate({ profiles: [{ name: "production", tags: ["prod"], environment, unprovenCommands: "allow" }] });
    assert.equal((await approval.authorize(operation())).allowed, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].reason, /Environment:/);
  }
  const { approval, requests } = gate();
  assert.equal((await approval.authorize(operation())).allowed, true);
  assert.equal(requests.length, 0);
});

test("profile always asks even for unknowns when global unknown allow", async () => {
  const { approval, requests } = gate({ profiles: [{ name: "strict", hosts: ["*"], policy: "always" }] });
  await approval.authorize(operation());
  await approval.authorize(operation({ subject: "df -h" }));
  assert.equal(requests.length, 2);
});

test("profile never denies changes and unknowns, but permits proven readonly", async () => {
  const { approval, requests } = gate({ profiles: [{ name: "blocked", tags: ["prod"], policy: "never" }, { name: "always", hosts: ["*"], policy: "always" }] });
  assert.equal((await approval.authorize(operation())).allowed, false);
  assert.equal((await approval.authorize(operation({ subject: "systemctl restart nginx", mutating: true }))).allowed, false);
  assert.equal((await approval.authorize(operation({ subject: "df -h" }))).allowed, true);
  assert.equal(requests.length, 0);
});

test("readonly profiles cover commands and file writes regardless of loose caller flags", async () => {
  const { approval, requests } = gate({ profiles: [{ name: "readonly", hosts: ["prod-*"], readonly: true }] });
  assert.equal((await approval.authorize(operation({ subject: "rm /tmp/example" }))).allowed, false);
  assert.equal((await approval.authorize(operation())).allowed, false);
  assert.equal((await approval.authorize(operation({ action: "write", subject: "/tmp/example", mutating: true }))).allowed, false);
  assert.equal((await approval.authorize(operation({ subject: "df -h" }))).allowed, true);
  assert.equal(requests.length, 0);
});

test("profile deny patterns are enforced in authorize even without host-aware assess", async () => {
  const { approval, requests } = gate({ profiles: [{ name: "deny", tags: ["prod"], denyCommandPatterns: ["\\bdf\\b"] }] });
  assert.equal(approval.assessCommand("df -h").denied, undefined);
  assert.match(approval.assessCommand("df -h", HOST).denied, /denyCommandPatterns/);
  assert.equal((await approval.authorize(operation({ subject: "df -h" }))).allowed, false);
  assert.equal(requests.length, 0);
});

test("shortcut inherits trusted entrance names and tags without trusting shell output", () => {
  const host = { ...HOST, name: "cluster-a", viaHost: "entry-prod", tags: ["cluster"], connectionPolicyNames: ["entry-prod"], connectionPolicyTags: ["prod"] };
  const config = normalizeConfig({ profiles: [{ name: "entry-name", hosts: ["entry-*"] }, { name: "entry-tag", tags: ["prod"], environment: "production" }] });
  const result = resolveSafetyProfile(config, host);
  assert.deepEqual(result.profiles, ["entry-name", "entry-tag"]);
  assert.equal(result.unprovenCommands, "ask");
  const { approval } = gate(config);
  const reason = approval.buildReason({ action: "execute", host, subject: "df -h" });
  assert.match(reason, /SSH entrance: entry-prod/);
  assert.match(reason, /not inferred from arbitrary output/);
});

test("approval keeps complete long multiline command and Diff with target/environment/impact", async () => {
  const { approval, requests } = gate({ profiles: [{ name: "prod", hosts: ["prod-*"], environment: "production", impact: "May interrupt web availability" }] });
  const subject = `printf '%s\\n' '${"a".repeat(400)}'\n  systemctl restart nginx\n`;
  const preview = "--- before: version-a\n+++ after: version-b\n@@\n-old\n+new\n";
  await approval.authorize(operation({ subject, mutating: true, preview }));
  assert.equal(requests.length, 1);
  const reason = requests[0].reason;
  assert.ok(reason.includes(`Complete command:\n${subject}`));
  assert.ok(reason.includes(`Diff preview:\n${preview}`));
  assert.match(reason, /ops@192\.0\.2\.11:2222/);
  assert.match(reason, /Environment: production/);
  assert.match(reason, /May interrupt web availability/);
});

test("oversize UTF-8 commands fail closed without asking, never approving a suffix", async () => {
  const { approval, requests } = gate({ policy: "always" });
  const subject = "界".repeat(Math.floor(MAX_APPROVAL_SUBJECT_BYTES / 3) + 1);
  const result = await approval.authorize(operation({ subject, mutating: true }));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /split the operation/);
  assert.equal(requests.length, 0);
  assert.throws(() => approval.buildReason({ action: "execute", host: HOST, subject }), /exceeds/);
});

test("oversize preview has explicit warning and preserves valid UTF-8 multiline prefix", () => {
  const { approval } = gate();
  const preview = `--- version-before\n+++ version-after\n${"界".repeat(MAX_APPROVAL_PREVIEW_BYTES)}`;
  const reason = approval.buildReason({ action: "write", host: HOST, subject: "/etc/example.conf", preview });
  assert.match(reason, /Diff preview:\n--- version-before\n\+\+\+ version-after/);
  assert.match(reason, /Diff preview truncated.*not the complete change/);
  assert.ok(!reason.includes("\ufffd"));
});

test("saved initialization remains trusted under all modes and production ask profiles", async () => {
  for (const policy of ["auto", "always", "never"]) {
    const { config, requests } = gate({ policy, unprovenCommands: "ask", profiles: [{ name: "prod", tags: ["prod"], environment: "production", policy: "always" }] });
    const host = { ...HOST, viaHost: "bastion", actions: [{ type: "command", value: "sudo su - root" }] };
    assert.ok(await authorizeConnectionLogin(host, { config, hosts: { isReadonly: () => false } }));
    assert.equal(requests.length, 0);
  }
});

test("saved initialization still preserves global hard deny and readonly restrictions", async () => {
  const host = { ...HOST, viaHost: "bastion", actions: [{ type: "command", value: "sudo su - root" }] };
  await assert.rejects(authorizeConnectionLogin(host, { config: normalizeConfig({ denyCommandPatterns: ["sudo"] }) }), /Denied/);
  await assert.rejects(authorizeConnectionLogin({ ...host, readonly: true }, { config: normalizeConfig({}) }), /Denied/);
});

test("profile normalization validates selectors, types, regex and unique names without aliasing", () => {
  const raw = [{ name: " prod ", hosts: [" prod-* "], tags: ["prod", "prod"], readonly: false }];
  const normalized = normalizeSafetyProfiles(raw);
  assert.equal(normalized[0].name, "prod");
  assert.deepEqual(normalized[0].tags, ["prod"]);
  raw[0].hosts.push("*");
  assert.deepEqual(normalized[0].hosts, ["prod-*"]);
  assert.deepEqual(normalizeSafetyProfiles(normalized), normalized);
  for (const value of [null, {}, [null], [{}], [{ name: "x" }], [{ name: "x", hosts: [""] }],
    [{ name: "x", tags: ["prod"], readonly: "false" }], [{ name: "x", hosts: ["*"], policy: "sometimes" }],
    [{ name: "x", hosts: ["*"], unprovenCommands: "deny" }], [{ name: "x", hosts: ["*"], denyCommandPatterns: ["("] }],
    [{ name: "x", hosts: ["*"] }, { name: "x", tags: ["prod"] }]]) {
    assert.throws(() => normalizeSafetyProfiles(value), /profiles/);
  }
});

test("configured target checks preserve exact operator declarations", () => {
  const checks = [{ name: "site", command: "hostname", expected: "synthetic-site" }];
  const raw = { profiles: [{ name: "target", hosts: ["prod-*"], targetChecks: checks }] };
  const config = normalizeConfig(Config(raw));
  assert.deepEqual(resolveSafetyProfile(config, HOST).targetChecks, checks);
  assert.deepEqual(normalizeConfig(config), config);
});

test("schema and normalize support profiles plus bounded audit fields", () => {
  const raw = { profiles: [{ name: "prod", tags: ["prod"], environment: "production" }], auditLimit: 1000, auditMaxBytes: 1024, auditRetentionDays: 3650 };
  const config = normalizeConfig(Config(raw));
  assert.equal(config.profiles[0].policy, undefined);
  assert.equal(config.profiles[0].readonly, undefined);
  assert.equal(config.auditLimit, 1000);
  assert.equal(config.auditMaxBytes, 1024);
  assert.equal(config.auditRetentionDays, 3650);
  assert.deepEqual(normalizeConfig(config), config);
  for (const [field, invalid] of [["auditLimit", 0], ["auditLimit", 100001], ["auditMaxBytes", 1023], ["auditMaxBytes", 1073741825], ["auditRetentionDays", 0], ["auditRetentionDays", 3651]]) {
    assert.throws(() => normalizeConfig({ [field]: invalid }), new RegExp(field));
    assert.throws(() => Config({ [field]: invalid }), new RegExp(field));
  }
  assert.throws(() => normalizeConfig({ profiles: [{ name: "x" }] }), /selector/);
});
