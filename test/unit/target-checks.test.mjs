import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Config, normalizeConfig } from "../../lib/config.js";
import { resolveSafetyProfile } from "../../lib/safety-profile.js";
import { normalizeTargetChecks, composeTargetChecks, buildTargetScript, parseTargetOutput, targetOutputComplete, assertTargetCommandContext, MAX_TARGET_OUTPUT_BYTES } from "../../lib/target-checks.js";

const nonce = "a".repeat(32);
const checks = [{ name: "identity", command: "printf 'site-a\\n\\n'", expected: "site-a" }];
const prefix = `DSH_TARGET_${nonce}|`;
function execute(checks, action, prelude = "") {
  const script = buildTargetScript(checks, action, nonce);
  const result = spawnSync("/bin/sh", ["-c", `${prelude}${script.command}`], { encoding: "utf8", timeout: 3000, maxBuffer: MAX_TARGET_OUTPUT_BYTES * 2 });
  assert.ifError(result.error);
  return { ...result, script, parsed: parseTargetOutput(result.stdout, nonce, checks) };
}

test("target checks normalize defensively and strip only trailing newlines", () => {
  const input = [{ name: "node", command: "hostname", expected: " node-a \n\n" }];
  const result = normalizeTargetChecks(input);
  assert.equal(result[0].expected, " node-a ");
  input[0].expected = "changed";
  assert.equal(result[0].expected, " node-a ");
  assert.deepEqual(normalizeTargetChecks(result), result);
  assert.equal(normalizeTargetChecks([{ name: "context", command: "mystery-context", expected: "ctx" }]).length, 1, "unknown probes remain independently approvable");
});

test("invalid shapes, mutating checks, controls, size and contradictions fail closed", () => {
  for (const value of [null, {}, [null], [{}], [{ name: "x", command: "hostname", expected: "" }],
    [{ name: "x", command: "hostname", expected: "   " }], [{ name: "x", command: "hostname\nid", expected: "a" }],
    [{ name: "x", command: "rm /tmp/fixture", expected: "a" }], [{ name: "x", command: "hostname", expected: "a", token: "secret" }],
    [{ name: "x", command: "hostname", expected: "\0" }], [{ name: "x", command: "hostname", expected: "a".repeat(4097) }],
    [{ name: "x", command: "hostname", expected: "a" }, { name: "y", command: "hostname", expected: "b" }]]) {
    assert.throws(() => normalizeTargetChecks(value), /targetChecks/);
  }
  assert.throws(() => normalizeTargetChecks(Array.from({ length: 11 }, (_, i) => ({ name: `c${i}`, command: `printf '${i}'`, expected: `${i}` }))), /at most 10/);
});

test("profiles compose logical-target checks but inherit entrance safety restrictions", () => {
  const config = normalizeConfig({ profiles: [
    { name: "entry", hosts: ["entry"], tags: ["prod-entry"], readonly: true, targetChecks: [{ name: "entry-host", command: "hostname", expected: "bastion" }] },
    { name: "cluster", hosts: ["cluster-a"], targetChecks: [{ name: "cluster-host", command: "hostname", expected: "cluster-a" }] },
  ] });
  const direct = resolveSafetyProfile(config, { name: "entry", tags: ["prod-entry"] });
  assert.equal(direct.targetChecks[0].expected, "bastion");
  const shortcut = resolveSafetyProfile(config, { name: "cluster-a", tags: ["cluster"], connectionPolicyNames: ["entry"], connectionPolicyTags: ["prod-entry"] });
  assert.equal(shortcut.readonly, true);
  assert.deepEqual(shortcut.targetChecks, [{ name: "cluster-host", command: "hostname", expected: "cluster-a" }]);
  assert.deepEqual(resolveSafetyProfile(config, { name: "other", connectionPolicyNames: ["entry"] }).targetChecks, []);
  assert.deepEqual(normalizeConfig(Config({ profiles: [{ name: "x", hosts: ["*"], targetChecks: checks }] })).profiles[0].targetChecks, checks);
});

test("effective duplicates dedupe; contradictory matched target checks and >10 fail", () => {
  assert.equal(composeTargetChecks([checks, checks]).length, 1);
  assert.throws(() => composeTargetChecks([checks, [{ ...checks[0], expected: "site-b" }]]), /contradictory/);
  assert.throws(() => composeTargetChecks([checks, [{ ...checks[0], command: "hostname" }]]), /contradictory/);
  assert.throws(() => composeTargetChecks([Array.from({ length: 6 }, (_, i) => ({ name: `a${i}`, command: `printf 'a${i}'`, expected: `a${i}` })), Array.from({ length: 6 }, (_, i) => ({ name: `b${i}`, command: `printf 'b${i}'`, expected: `b${i}` }))]), /at most 10/);
});

test("one-line generated wrapper verifies checks and emits real action status/output", () => {
  const result = execute(checks, "printf 'action-output'; exit 7");
  assert.equal(result.status, 7);
  assert.equal(result.parsed.status, "passed");
  assert.equal(result.parsed.actionExecuted, true);
  assert.equal(result.parsed.exitCode, 7);
  assert.equal(result.parsed.actionOutput, "action-output");
  assert.equal(result.parsed.checks[0].actual, "site-a");
  assert.equal(result.parsed.checks[0].exitCode, 0);
  assert.ok(!/[\r\n]/.test(result.script.command));
  assert.ok(Buffer.byteLength(result.script.command) <= 65536);
  assert.equal(targetOutputComplete(result.stdout, nonce), true);
});

test("original action newlines are preserved, framing newlines and source echo removed", () => {
  for (const action of ["printf 'one\\n'", "printf 'one\\ntwo\\n\\n'", "printf 'one\\ntwo'"]) {
    const plain = spawnSync("/bin/sh", ["-c", action], { encoding: "utf8" }).stdout;
    const result = execute(checks, action);
    assert.equal(result.parsed.actionOutput, plain);
    assert.deepEqual(parseTargetOutput(result.script.command + "\r\n" + result.stdout.replaceAll("\n", "\r\n") + "user@fixture$ ", nonce, checks), result.parsed);
  }
});

test("check-only has no action proof and cannot kill the surrounding user shell", () => {
  const result = execute(checks);
  assert.equal(result.status, 0);
  assert.equal(result.parsed.status, "passed");
  assert.equal(result.parsed.actionExecuted, false);
  assert.equal(result.parsed.exitCode, undefined);
  const script = buildTargetScript(checks, "exit 9", nonce);
  const outer = spawnSync("/bin/sh", ["-c", `${script.command}; printf '\\nPARENT_SURVIVED\\n'`], { encoding: "utf8" });
  assert.match(outer.stdout, /PARENT_SURVIVED/);
  assert.equal(parseTargetOutput(outer.stdout, nonce, checks).exitCode, 9);
});

test("mismatch and probe failure never evaluate the action, including expected-output rc!=0", () => {
  const mismatch = execute([{ ...checks[0], expected: "site-b" }], "printf ACTION_MUST_NOT_RUN");
  assert.equal(mismatch.status, 125);
  assert.equal(mismatch.parsed.status, "mismatch");
  assert.equal(mismatch.parsed.actionExecuted, false);
  assert.ok(!mismatch.stdout.includes("ACTION_MUST_NOT_RUN"));
  const failed = execute([{ name: "fail", command: "printf 'site-a'; false", expected: "site-a" }], "printf ACTION_MUST_NOT_RUN");
  assert.equal(failed.parsed.status, "failed");
  assert.equal(failed.parsed.checks[0].exitCode, 1);
  assert.equal(failed.parsed.actionExecuted, false);
});

test("exact target compares preserve spaces, internal newlines, Unicode and quotes", () => {
  for (const value of ["one\ntwo", " node-a ", "区域'\"a"]) {
    const command = `printf '%s' '${value.replaceAll("'", `'"'"'`).replaceAll("\n", "\\n")}'`;
    const probe = value.includes("\n") ? "printf 'one\\ntwo\\n\\n'" : command;
    const result = execute([{ name: "value", command: probe, expected: value }]);
    assert.equal(result.parsed.status, "passed");
    assert.equal(result.parsed.checks[0].actual, value);
  }
});

test("stdout NUL bytes are never silently erased into a matching identity", () => {
  const result = execute([{ name: "binary", command: "printf 'site\\0-a'", expected: "site-a" }], "printf ACTION_MUST_NOT_RUN");
  assert.equal(result.parsed.status, "mismatch");
  assert.equal(result.parsed.checks[0].actual, "site\0-a");
  assert.equal(result.parsed.actionExecuted, false);
  assert.ok(!result.stdout.includes("ACTION_MUST_NOT_RUN"));
});

test("guard retains unexported shell function and current inherited cwd/environment", () => {
  const local = [{ name: "function", command: "identity_fn", expected: "same-context" }, { name: "cwd", command: "pwd", expected: "/" }];
  const result = execute(local, "identity_fn; pwd", "identity_fn() { printf same-context; }; cd /; ");
  assert.equal(result.parsed.status, "passed");
  assert.equal(result.parsed.actionOutput, "same-context/\n");
});

test("nonce-private wrapper variables do not shadow inherited helper context", () => {
  const local = [{ name: "function-vars", command: "ambient_fn", expected: "site-a:parent-p:parent-r:parent-hex:parent-cap" }];
  const result = execute(local, "ambient_fn", "state=site-a; p=parent-p; r=parent-r; hex=parent-hex; cap=parent-cap; ambient_fn() { printf '%s:%s:%s:%s:%s' \"$state\" \"$p\" \"$r\" \"$hex\" \"$cap\"; }; ");
  assert.equal(result.parsed.status, "passed");
  assert.equal(result.parsed.actionOutput, local[0].expected);
});

test("oversize probe output or unavailable framing utilities fails before action", () => {
  const result = execute([{ name: "large", command: "yes x | head -c 5000", expected: "x" }], "printf ACTION_MUST_NOT_RUN");
  assert.equal(result.parsed.status, "failed");
  assert.equal(result.parsed.actionExecuted, false);
  assert.ok(!result.stdout.includes("ACTION_MUST_NOT_RUN"));
  const missing = execute(checks, "printf ACTION_MUST_NOT_RUN", "PATH=/definitely-missing; ");
  assert.equal(missing.status, 125);
  assert.equal(missing.parsed.status, "unknown");
  assert.equal(missing.parsed.actionExecuted, null);
  assert.ok(!missing.stdout.includes("ACTION_MUST_NOT_RUN"));
});

test("incomplete, wrong nonce, duplicate, reordered, malformed and conflicting frames are unknown", () => {
  const valid = execute(checks, "printf ok").stdout;
  const invalid = [valid.slice(0, -1), valid.replace(`${prefix}BEGIN\n`, ""), valid + `${prefix}BEGIN\n`,
    valid.replace(`${prefix}CHECK|0|0|`, `${prefix}CHECK|1|0|`), valid.replace("END|passed", "END|failed"),
    valid.replace("ACTION_EXIT|0", "ACTION_EXIT|256"), valid.replace("CHECK|0|0|", "CHECK|0|0|g"),
    valid.replace("ACTION_EXIT|0", "ACTION_START"), valid.slice(0, valid.indexOf(`${prefix}ACTION_EXIT`)),
    `${prefix}BEGIN\n${prefix}CHECK|0|0|ff\n${prefix}END|passed\n`];
  for (const output of invalid) {
    const parsed = parseTargetOutput(output, nonce, checks);
    assert.equal(parsed.status, "unknown");
    assert.equal(parsed.actionExecuted, null, "unknown cannot imply the action did not execute");
  }
  assert.equal(parseTargetOutput(valid, "b".repeat(32), checks).status, "unknown");
  assert.equal(parseTargetOutput("x".repeat(MAX_TARGET_OUTPUT_BYTES + 1) + valid, nonce, checks).status, "unknown");
});

test("source echo, partial END, prompt and stale/different nonce never complete", () => {
  const { command } = buildTargetScript(checks, "printf ok", nonce);
  for (const output of [command, command + "\nfixture$ ", `${prefix}END|passed`, `text ${prefix}END|passed\n`, `DSH_TARGET_${"b".repeat(32)}|END|passed\n`, `${prefix}END|pas`]) {
    assert.equal(targetOutputComplete(output, nonce), false);
  }
  assert.equal(targetOutputComplete(`${prefix}END|passed\n`, nonce), true);
});

test("known context overrides and opaque shell work reject only guarded actions", () => {
  for (const command of ["ssh other hostname", "s''sh other hostname", "sudo hostname", "env KUBECONFIG=other kubectl get pods", "KUBECONFIG=other kubectl get pods", "command ssh other id", "sh -c 'hostname'", "kubectl --context other get pods", "kubectl get pods -n other", "docker -H other ps", "systemctl --host other status nginx", "kubectl exec pod -- hostname", "docker exec box hostname", "hostname &", "python3 -c 'print(1)'", "\"$TOOL\" get pods"]) {
    assert.throws(() => assertTargetCommandContext(command), /context|syntax|target/);
    assert.throws(() => buildTargetScript(checks, command), /context|syntax|target/);
  }
  for (const command of ["grep -n pattern /etc/hosts", "curl -H 'Accept: text/plain' https://example.invalid", "kubectl get pods", "docker ps", "systemctl restart nginx", "printf '%s' 'a;exit 9'"]) assert.equal(assertTargetCommandContext(command), true);
  assert.ok(buildTargetScript([], "ssh other hostname").command, "no-check callers retain ordinary behavior, policy is separate");
});

test("wrapped, compound and substituted probes cannot attest a different context", () => {
  const commands = ['command ssh other hostname', 'command kubectl --context other config current-context', 'timeout 3 kubectl --context other config current-context', 'command env KUBECONFIG=other kubectl config current-context', 'if true; then ssh other hostname; fi', 'for x in one; do ssh other hostname; done', '! kubectl --context other get pods', "printf '%s' \"$(ssh other hostname)\"", 'kubectl config use-context other'];
  for (const command of commands) {
    assert.throws(() => normalizeTargetChecks([{ name: 'context', command, expected: 'expected' }]), /context|grammar|configuration|expansion/);
    assert.throws(() => buildTargetScript(checks, command), /context|grammar|configuration|expansion/);
  }
  assert.throws(() => buildTargetScript(checks, 'kubectl --cluster other get pods'), /context|target/);
  assert.throws(() => buildTargetScript(checks, 'systemctl --root=/other restart nginx'), /context|target/);
});

test("script and nonce bounds refuse oversized assembled or invalid protocol inputs", () => {
  assert.throws(() => buildTargetScript(checks, "x".repeat(4097)), /bounded/);
  assert.throws(() => buildTargetScript(checks, undefined, "bad nonce; id"), /nonce/);
  assert.throws(() => buildTargetScript(Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, command: `printf '${"x".repeat(4000)}${i}'`, expected: "x" }))), /64 KiB/);
});
