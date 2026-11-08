import assert from "node:assert/strict";
import test from "node:test";
import { classifyAuditResult, redactAuditText } from "../../lib/audit-result.js";

test("exec completion is classified by timeout and actual exit proof", () => {
  assert.equal(classifyAuditResult("remote_exec", { exitCode: 0 }).outcome, "ok");
  assert.equal(classifyAuditResult("remote_exec", { exitCode: 7 }).outcome, "failed");
  assert.equal(classifyAuditResult("remote_exec", { exitCode: 0, timedOut: true }).outcome, "timed_out");
  assert.equal(classifyAuditResult("remote_exec", { exitCode: -1 }).outcome, "unknown");
  assert.equal(classifyAuditResult("remote_exec", {}).outcome, "unknown");
  assert.equal(classifyAuditResult("remote_exec", { exitCode: 0, signal: "TERM" }).outcome, "unknown");
});

test("shell settle and shell exit are never arbitrary command success proof", () => {
  for (const waitReason of ["inferred_idle", "prompt", "session_exit"]) {
    assert.equal(classifyAuditResult("remote_shell_send", { waitReason, sessionStatus: { kind: "exited", exitCode: 0 } }).outcome, "unknown");
  }
  assert.equal(classifyAuditResult("remote_shell_send", { waitReason: "timeout" }).outcome, "timed_out");
});

test("denial, cancellation, uncertainty and validation failures stay distinct", () => {
  const classify = (error) => classifyAuditResult("remote_edit", undefined, error);
  assert.equal(classify({ code: "DENIED", message: "secret Diff" }).outcome, "denied");
  assert.equal(classify({ name: "AbortError" }).outcome, "cancelled");
  assert.equal(classify({ outcome: "cancelled" }).outcome, "cancelled");
  assert.equal(classify({ code: "TIMEOUT" }).outcome, "timed_out");
  assert.equal(classify({ code: "CONNECTION" }).outcome, "unknown");
  assert.equal(classify({ code: "EACCES" }).outcome, "error");
  assert.equal(classify({ code: "EACCES", change: { writeAttempted: true } }).outcome, "unknown");
  assert.equal(classify({ code: "VERIFICATION_FAILED" }).outcome, "verification_failed");
  assert.equal(classify({ code: "VERIFICATION_TIMEOUT" }).outcome, "timed_out");
  assert.equal(classify({ code: "VERIFICATION_UNKNOWN" }).outcome, "unknown");
  assert.equal(classify({ code: "VERIFICATION_FAILED", change: { verification: { status: "unknown", exitCode: 0 } } }).outcome, "unknown");
  assert.equal(classifyAuditResult("remote_exec", undefined, new Error("unclassified failure")).outcome, "unknown");
  assert.equal(classify({ code: "VERIFICATION_FAILED", message: "read-only in private Diff" }).outcome, "verification_failed");
  assert.equal(classify({ code: "EACCES", message: "denied inside private Diff", change: { writeAttempted: true } }).outcome, "unknown");
  assert.equal(classifyAuditResult("remote_edit", { verification: { status: "passed", exitCode: 2 } }).outcome, "verification_failed");
  assert.equal(classifyAuditResult("remote_edit", { verification: { status: "passed", timedOut: true } }).outcome, "timed_out");
});

test("only whitelisted recovery facts are retained, not error text or result output", () => {
  const entry = classifyAuditResult("remote_edit", undefined, {
    code: "VERIFICATION_FAILED", message: "PRIVATE DIFF CONTENT", change: {
      backupId: "backup-1", beforeVersion: "before", afterVersion: null, writeAttempted: true,
      content: "PRIVATE FILE CONTENT", diff: "PRIVATE DIFF CONTENT",
      verification: { status: "failed", exitCode: 1, timedOut: false, stdout: "PRIVATE STDOUT", command: "PRIVATE COMMAND" },
    },
  });
  assert.equal(entry.backupId, "backup-1");
  assert.equal(entry.afterVersion, null);
  assert.deepEqual(entry.verification, { status: "failed", exitCode: 1, timedOut: false });
  assert.equal(JSON.stringify(entry).includes("PRIVATE"), false);
  for (const status of ["passed", "failed", "timed_out", "cancelled", "unknown"]) {
    const expected = { passed: "ok", failed: "verification_failed", timed_out: "timed_out", cancelled: "cancelled", unknown: "unknown" }[status];
    assert.equal(classifyAuditResult("remote_edit", { verification: { status } }).outcome, expected);
  }
});

test("common secret forms are redacted before bounding while ordinary commands remain", () => {
  assert.equal(redactAuditText("kubectl get pods -n demo"), "kubectl get pods -n demo");
  const examples = [
    'PASSWORD="sensitive value" env', "token=supersecret", "--password supersecret",
    'curl -H "Authorization: Bearer supersecret"', "https://user:supersecret@example.invalid/path",
    'api_key: "supersecret"', "MY_APP_TOKEN=supersecret", "--api-key=supersecret",
    "-----BEGIN RSA PRIVATE KEY-----\nsupersecret\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nsupersecret",
  ];
  for (const raw of examples) assert.equal(redactAuditText(raw).includes("supersecret"), false, raw);
  assert.equal(redactAuditText('PASSWORD="sensitive value"').includes("sensitive"), false);
  assert.equal(redactAuditText("x".repeat(100), 10).length, 10);
  assert.equal(redactAuditText(null), "");
});

test("target uncertainty and framed PTY outcomes are classified conservatively", () => {
  assert.equal(classifyAuditResult('remote_target_check', undefined, { code: 'TARGET_OUTCOME_UNKNOWN' }).outcome, 'unknown');
  for (const [status, expected] of [['passed', 'ok'], ['failed', 'failed'], ['mismatch', 'failed'], ['unknown', 'unknown']]) assert.equal(classifyAuditResult('remote_target_check', { status, checks: [] }).outcome, expected);
  const evidence = { status: 'passed', actionExecuted: true, actionAttempted: true, checks: [{ name: 'context', expected: 'PRIVATE', actual: 'PRIVATE', command: 'PRIVATE' }] };
  const result = classifyAuditResult('remote_shell_send', { exitCode: 3, waitReason: 'protocol_complete', targetEvidence: evidence });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 3);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(classifyAuditResult('remote_shell_send', { exitCode: 0, waitReason: 'protocol_complete', targetEvidence: evidence, truncated: true }).outcome, 'unknown');
});

test("target evidence retains only bounded proof metadata, not unrelated identifiers", () => {
  const evidence = { status: "passed", checks: [{ name: "site", expected: "PRIVATE", actual: "PRIVATE" }], actionExecuted: false, actionAttempted: false, context: "ssh-exec-subshell", checkedAt: 12345 };
  const result = classifyAuditResult("remote_target_check", { ...evidence, runId: "retired-record", stepId: "retired-step" });
  assert.deepEqual(result.targetEvidence, { status: "passed", checkCount: 1, actionExecuted: false, actionAttempted: false, context: "ssh-exec-subshell", checkedAt: 12345 });
  for (const key of ["runId", "stepId", "runStatus"]) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  const failed = classifyAuditResult("remote_target_check", undefined, { code: "TARGET_OUTCOME_UNKNOWN", runId: "retired-record", stepId: "retired-step", targetEvidence: { ...evidence, status: "unknown" } });
  assert.equal(failed.outcome, "unknown");
  assert.equal(failed.targetEvidence.status, "unknown");
  for (const key of ["runId", "stepId", "runStatus"]) assert.equal(Object.hasOwn(failed, key), false);
});

test("probe failure is not success; ordinary bounded read completion remains ok", () => {
  assert.equal(classifyAuditResult("remote_probe", { ok: false }).outcome, "failed");
  assert.equal(classifyAuditResult("remote_read", { content: "not retained" }).outcome, "ok");
});
