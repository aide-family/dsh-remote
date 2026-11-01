/**
 * Unit tests for the approval gate (lib/approval.js).
 *
 * The gate is pure apart from `ctx.get("approval")`: policy decisions, deny
 * patterns, reason construction, and every outcome of the DSH approval seam are
 * covered with an injected fake service.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compileDenyPatterns, createApprovalGate, formatHost, truncateSubject } from "../../lib/approval.js";

const HOST = {
  id: "config:prod-web-1",
  name: "prod-web-1",
  host: "10.0.0.11",
  port: 22,
  username: "ops",
  source: "config",
};

const EXEC = { agent: { id: "agent-1" }, callId: "call-1", signal: new AbortController().signal };

function config(overrides = {}) {
  return {
    policy: "auto",
    denyCommandPatterns: [],
    readonlyHosts: [],
    allowHosts: [],
    ...overrides,
  };
}

function gate({ policy = "auto", denyCommandPatterns = [], approval } = {}) {
  const calls = [];
  const ctx = {
    get(name) {
      if (name !== "approval") return undefined;
      if (approval === null) return undefined;
      return {
        async request(request) {
          calls.push(request);
          if (typeof approval === "function") return approval(request);
          return approval ?? "allowed-once";
        },
      };
    },
  };
  return { gate: createApprovalGate({ ctx, config: config({ policy, denyCommandPatterns }) }), calls };
}

test("assessCommand: read-only commands are low risk", () => {
  const { gate: g } = gate();
  assert.equal(g.assessCommand("ls -la /var/log").level, "low");
  assert.equal(g.assessCommand("systemctl status nginx").level, "low");
});

test("assessCommand: mutating commands are high risk", () => {
  const { gate: g } = gate();
  assert.equal(g.assessCommand("rm -rf /var/tmp/x").level, "high");
  assert.equal(g.assessCommand("systemctl restart nginx").level, "high");
  assert.equal(g.assessCommand("kubectl delete pod web-0").level, "high");
});

test("assessCommand: unknown binaries are gray risk", () => {
  const { gate: g } = gate();
  assert.equal(g.assessCommand("mystery-tool --frobnicate").level, "gray");
});

test("assessCommand: denyCommandPatterns denies regardless of level", () => {
  const { gate: g } = gate({ denyCommandPatterns: ["shutdown", "\\bmkfs\\b"] });
  const denied = g.assessCommand("sudo shutdown -h now");
  assert.equal(denied.level, "high");
  assert.match(denied.denied, /denyCommandPatterns/);
  assert.match(g.assessCommand("mkfs.ext4 /dev/sdb1").denied, /denyCommandPatterns/);
  assert.equal(g.assessCommand("ls /").denied, undefined);
});

test("compileDenyPatterns skips invalid entries with a warning", () => {
  const warnings = [];
  const compiled = compileDenyPatterns(["ok", "([unclosed", ""], (message) => warnings.push(message));
  assert.equal(compiled.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid denyCommandPatterns/);
});

test("authorize: read-only action under auto policy is allowed without asking", async () => {
  const { gate: g, calls } = gate();
  const decision = await g.authorize({
    toolName: "remote_read",
    exec: EXEC,
    host: HOST,
    action: "read",
    subject: "/etc/hostname",
    mutating: false,
  });
  assert.deepEqual(decision, { allowed: true });
  assert.equal(calls.length, 0);
});

test("authorize: read-only action under always policy asks", async () => {
  const { gate: g, calls } = gate({ policy: "always" });
  const decision = await g.authorize({
    toolName: "remote_read",
    exec: EXEC,
    host: HOST,
    action: "read",
    subject: "/etc/hostname",
    mutating: false,
  });
  assert.equal(decision.allowed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "remote_read");
  assert.equal(calls[0].agent, EXEC.agent);
  assert.equal(calls[0].callId, "call-1");
});

test("authorize: readonly host denies mutating actions before asking", async () => {
  const { gate: g, calls } = gate();
  const decision = await g.authorize({
    toolName: "remote_write",
    exec: EXEC,
    host: HOST,
    action: "write",
    subject: "/etc/nginx/nginx.conf",
    mutating: true,
    readonlyHost: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /read-only/);
  assert.equal(calls.length, 0);
});

test("authorize: policy never denies mutating actions without asking", async () => {
  const { gate: g, calls } = gate({ policy: "never" });
  const decision = await g.authorize({
    toolName: "remote_exec",
    exec: EXEC,
    host: HOST,
    action: "execute",
    subject: "systemctl restart nginx",
    mutating: true,
    verb: "restart",
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy is "never"/);
  assert.equal(calls.length, 0);
});

test("authorize: auto policy asks for mutating actions and allows on allowed-once", async () => {
  const { gate: g, calls } = gate();
  const decision = await g.authorize({
    toolName: "remote_exec",
    exec: EXEC,
    host: HOST,
    action: "execute",
    subject: "systemctl restart nginx",
    mutating: true,
    verb: "restart",
    description: "restart the web tier",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.outcome, "allowed-once");
  assert.equal(calls.length, 1);
  assert.match(calls[0].reason, /ops@10\.0\.0\.11/);
  assert.match(calls[0].reason, /systemctl restart nginx/);
  assert.match(calls[0].reason, /risk: restart/);
  assert.match(calls[0].reason, /restart the web tier/);
});

test("authorize: rejected, cancelled and unavailable all deny with distinct reasons", async () => {
  for (const [outcome, pattern] of [
    ["rejected", /rejected by the user/],
    ["cancelled", /cancelled/],
    ["unavailable", /fail closed/],
  ]) {
    const { gate: g } = gate({ approval: outcome });
    const decision = await g.authorize({
      toolName: "remote_write",
      exec: EXEC,
      host: HOST,
      action: "write",
      subject: "/tmp/x",
      mutating: true,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, pattern);
  }
});

test("authorize: a throwing approval service fails closed", async () => {
  const { gate: g } = gate({
    approval: () => {
      throw new Error("boom");
    },
  });
  const decision = await g.authorize({
    toolName: "remote_exec",
    exec: EXEC,
    host: { name: "h", host: "h" },
    action: "execute",
    subject: "rm -rf /tmp/x",
    mutating: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /approval request failed: boom/);
});

test("authorize: missing approval service fails closed", async () => {
  const { gate: g } = gate({ approval: null });
  const decision = await g.authorize({
    toolName: "remote_exec",
    exec: EXEC,
    host: HOST,
    action: "execute",
    subject: "rm -rf /tmp/x",
    mutating: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no approval answerer is mounted/);
});

test("authorize: an unknown approval outcome fails closed", async () => {
  const { gate: g } = gate({ approval: "weird-outcome" });
  const decision = await g.authorize({
    toolName: "remote_write",
    exec: EXEC,
    host: HOST,
    action: "write",
    subject: "/tmp/x",
    mutating: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /unexpected approval outcome/);
});

test("formatHost omits the default port and includes the user", () => {
  assert.equal(formatHost(HOST), "ops@10.0.0.11");
  assert.equal(formatHost({ ...HOST, port: 2222 }), "ops@10.0.0.11:2222");
  assert.equal(formatHost({ name: "h", host: "h" }), "h");
});

test("truncateSubject bounds long commands", () => {
  const long = `echo ${"a".repeat(500)}`;
  const result = truncateSubject(long);
  assert.ok(result.length <= 300);
  assert.ok(result.endsWith("…"));
  assert.equal(truncateSubject("  ls   -la  "), "ls -la");
});
