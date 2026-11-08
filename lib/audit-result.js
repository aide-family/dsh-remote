/** Pure, conservative audit classification. No stdout, Diff or exception text is retained. */
export function classifyAuditResult(toolName, value, error) {
  const facts = { ...changeFacts(error?.change ?? value), ...targetFacts(value, error) };
  const result = (outcome, summary, extra = {}) => ({ outcome, summary, ...facts, ...extra });
  if (error !== undefined && error !== null) {
    const code = String(error.code ?? "");
    const message = String(error.message ?? "");
    if (error.name === "AbortError" || error.outcome === "cancelled" || code === "CANCELLED") {
      return result("cancelled", "Call cancelled; remote state may require verification");
    }
    if (error.outcome === "denied" || code === "DENIED") return result("denied", "Action denied");
    if (code === "VERIFICATION_TIMEOUT" || facts.verification?.status === "timed_out") {
      return result("timed_out", "Post-change verification timed out");
    }
    if (facts.verification?.status === "cancelled") return result("cancelled", "Post-change verification cancelled");
    if (code === "VERIFICATION_UNKNOWN" || facts.verification?.status === "unknown") return result("unknown", "Post-change verification outcome is unknown");
    if (code === "VERIFICATION_FAILED" || ["failed", "validation-failed"].includes(facts.verification?.status)) {
      return result("verification_failed", "Post-change verification failed");
    }
    if (code === "TIMEOUT") return result("timed_out", "Call timed out; remote state is not proven");
    if (code === "TARGET_OUTCOME_UNKNOWN") return result("unknown", "Remote result/state persistence is not proven; inspect before any retry");
    // Legacy gates lack typed denial codes. Use their message only for classification,
    // after explicit recovery facts; never copy it into the audit summary.
    if (!error.change && /denied|rejected by the user|read-only|policy is ["']never|fail.closed|not allowed by.*allowHosts/i.test(message)) return result("denied", "Action denied");
    const uncertain = /CONNECTION|CHANNEL|ECONNRESET|EPIPE|CONNECT/.test(code) || /connection.*(lost|closed|failed|reset)|channel.*(closed|failed)|socket.*(closed|reset)/i.test(message);
    if (facts.writeAttempted === true || uncertain || toolName === "remote_exec" || toolName === "remote_shell_send") {
      return result("unknown", "Execution outcome is not proven");
    }
    return result("error", "Tool call failed");
  }
  if (facts.verification?.status === "timed_out") return result("timed_out", "Post-change verification timed out");
  if (facts.verification?.status === "cancelled") return result("cancelled", "Post-change verification cancelled");
  if (["failed", "validation-failed"].includes(facts.verification?.status)) return result("verification_failed", "Post-change verification failed");
  if (facts.verification?.status === "unknown") return result("unknown", "Post-change verification outcome is unknown");
  if (toolName === "remote_exec") {
    const exitCode = Number.isInteger(value?.exitCode) ? value.exitCode : undefined;
    const extra = exitCode === undefined ? {} : { exitCode };
    if (value?.timedOut === true) return result("timed_out", "Remote command timed out", extra);
    if (exitCode === undefined || exitCode < 0 || value?.signal) return result("unknown", "Remote exit success is not proven", extra);
    return result(exitCode === 0 ? "ok" : "failed", exitCode === 0 ? "Remote command exited successfully" : "Remote command exited unsuccessfully", extra);
  }
  if (toolName === "remote_target_check") return result(value?.status === "passed" ? "ok" : value?.status === "unknown" ? "unknown" : "failed", "Configured target-check result");
  if (toolName === "remote_shell_send") {
    if (value?.waitReason === "protocol_complete" && value.targetEvidence?.status === "passed" && value.targetEvidence.actionExecuted === true &&
        Number.isInteger(value.exitCode) && value.exitCode >= 0 && !value.truncated && !value.timedOut && !value.signal) {
      return result(value.exitCode === 0 ? "ok" : "failed", "Guarded PTY command has explicit exit proof", { exitCode: value.exitCode });
    }
    // Silence, a prompt, and even the shell process's exit status do not prove
    // the status of an arbitrary submitted command (lists/pipelines included).
    return result(value?.waitReason === "timeout" ? "timed_out" : "unknown", "Shell input settled without command-exit proof");
  }
  if (toolName === "remote_probe" && value?.ok === false) return result("failed", "Connection probe failed");
  return result("ok", "Tool call completed");
}

function targetFacts(value, error) {
  const facts = {};
  const evidence = error?.targetEvidence ?? value?.targetEvidence ?? (Array.isArray(value?.checks) ? value : null);
  if (evidence && ["passed", "failed", "mismatch", "unknown"].includes(evidence.status)) {
    facts.targetEvidence = { status: evidence.status, checkCount: Math.min(10, evidence.checks?.length ?? 0),
      actionExecuted: typeof evidence.actionExecuted === "boolean" ? evidence.actionExecuted : null,
      actionAttempted: evidence.actionAttempted === true };
    if (["owned-pty-subshell", "ssh-exec-subshell"].includes(evidence.context)) facts.targetEvidence.context = evidence.context;
    if (Number.isFinite(evidence.checkedAt)) facts.targetEvidence.checkedAt = evidence.checkedAt;
  }
  return facts;
}

function changeFacts(source) {
  if (source === null || typeof source !== "object") return {};
  const facts = {};
  for (const key of ["backupId", "beforeVersion", "afterVersion"]) {
    if (source[key] === null) facts[key] = null;
    else if (typeof source[key] === "string") facts[key] = redactAuditText(source[key], 256);
  }
  if (typeof source.writeAttempted === "boolean") facts.writeAttempted = source.writeAttempted;
  const verification = source.verification;
  if (verification && typeof verification === "object") {
    let status = ["passed", "failed", "timed_out", "unknown", "cancelled", "validation-failed"].includes(verification.status) ? verification.status : "unknown";
    if (verification.timedOut === true) status = "timed_out";
    else if (status === "passed" && Number.isInteger(verification.exitCode) && verification.exitCode !== 0) status = verification.exitCode < 0 ? "unknown" : "failed";
    facts.verification = {
      status,
      ...(Number.isInteger(verification.exitCode) ? { exitCode: verification.exitCode } : {}),
      ...(typeof verification.timedOut === "boolean" ? { timedOut: verification.timedOut } : {}),
    };
  }
  return facts;
}

/** Best-effort common-secret redaction; not a proof that arbitrary text is safe. */
export function redactAuditText(value, maxChars = 16_384) {
  const max = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 16_384;
  let text = String(value ?? "");
  text = text
    .replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)[^-\r\n]*-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, "[REDACTED PEM]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/(\bAuthorization\s*[:=]\s*)(?:["']?)(?:Bearer|Basic)\s+[^\s"'\r\n]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret|[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|API_KEY))\b["']?\s*(?:[:=]|\s)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:password|passwd|token|secret|api-key|access-key)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|\r\n]+)/gi, "$1[REDACTED]");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
