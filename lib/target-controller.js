import { resolveSafetyProfile } from './safety-profile.js';
import { buildTargetScript, parseTargetOutput, targetOutputComplete, assertTargetCommandContext, composeTargetChecks } from './target-checks.js';
import { runVerifiedPty } from './terminal/verified-exec.js';
import { targetConnectionDigest, targetChecksDigest } from './target-binding.js';

const fail = (message, code, evidence) => {
  const details = evidence?.checks?.filter(check => check.status !== 'passed').slice(0, 10).map(check =>
    `${check.name}: expected=${JSON.stringify(String(check.expected ?? '').slice(0, 256))}, actual=${JSON.stringify(String(check.actual ?? 'unknown').slice(0, 256))}, status=${check.status}`);
  return Object.assign(new Error(message + (details?.length ? '\n' + details.join('\n') : '')), { code, ...(evidence ? { targetEvidence: evidence } : {}) });
};
const riskOf = (approval, command, host) => approval.assessCommand(command, host);

/** Runtime integration; all evidence comes from configured checks, not prompts. */
export function createTargetController({ config, transport, approval, hosts, manager, live, managedChecks, refreshManaged } = {}) {
  const maxBytes = Math.min(config.maxOutputBytes ?? 200000, 256 * 1024);
  const timeoutDefault = config.execTimeoutMs ?? 120000;
  const configuredChecksFor = host => resolveSafetyProfile(config, host).targetChecks ?? [];
  const refresh = async () => { if (refreshManaged) await refreshManaged(); };
  const checksFor = host => composeTargetChecks([configuredChecksFor(host), managedChecks ? managedChecks(host) : []]);
  async function snapshot(request) {
    await refresh();
    const current = await hosts.find(request.host.name);
    if (!current || !hosts.isAllowed(current)) throw fail('Current logical target is unavailable or denied.', 'DENIED');
    const wanted = request.expectedConnectionDigest ?? targetConnectionDigest(request.host);
    if (targetConnectionDigest(current) !== wanted) throw fail('Logical target connection/routing changed; no operation submitted.', 'TARGET_CONNECTION_CHANGED');
    const checks = checksFor(current);
    if (request.expectedChecksHash && targetChecksDigest(checks) !== request.expectedChecksHash) throw fail('The pinned target-check binding changed before dispatch.', 'TARGET_CONFIG_CHANGED');
    return { host: current, checks };
  }
  async function dispatchCheck(request) {
    const current = await snapshot(request);
    const safety = resolveSafetyProfile(config, current.host);
    if (request.command) {
      validateAction(current.host, request.command, false, false);
      const risk = riskOf(approval, request.command, current.host);
      if (request.approvedOnce !== true && (risk.level === 'high' || (risk.level === 'gray' && safety.unprovenCommands === 'ask'))) throw fail('Command approval requirements changed before dispatch.', 'DENIED');
    }
    if (request.mutating && (hosts.isReadonly(current.host) || safety.readonly || safety.policy === 'never')) throw fail('Current hard policy denies this mutation.', 'DENIED');
    if (safety.policy === 'always' && request.approvedOnce !== true) throw fail('Approval policy changed; request a fresh approval.', 'DENIED');
    if (request.ptyInput && !current.checks.length && (hosts.isReadonly(current.host) || safety.readonly || safety.policy === 'never')) throw fail('Unverified PTY input is denied under the current policy.', 'DENIED');
    return current;
  }
  function requires(host, command) {
    const risk = riskOf(approval, command, host);
    return checksFor(host).length > 0 && risk.level !== 'low';
  }
  async function authorize({ host, exec, command, toolName, description, targetEvidence, requireApproval = false, mutating }) {
    const risk = riskOf(approval, command, host);
    if (risk.denied) throw fail(risk.denied, 'DENIED');
    const decision = await approval.authorize({ toolName, exec, host, action: 'execute', subject: command,
      mutating: mutating ?? risk.level === 'high', unproven: risk.level === 'gray', verb: risk.verb,
      description, targetEvidence, requireApproval, readonlyHost: hosts.isReadonly(host) });
    if (decision?.allowed !== true) throw Object.assign(fail(decision?.reason ?? 'Target operation denied.', 'DENIED'), { outcome: decision?.outcome });
    exec.signal?.throwIfAborted();
    if (!hosts.isAllowed(host)) throw fail('Host is not allowed by allowHosts after approval.', 'DENIED');
    return decision;
  }
  function validateAction(host, command, requireChecks, requireApproval) {
    if (!hosts.isAllowed(host)) throw fail('Host is not allowed by allowHosts.', 'DENIED');
    const risk = riskOf(approval, command, host);
    if (risk.denied) throw fail(risk.denied, 'DENIED');
    const safety = resolveSafetyProfile(config, host);
    if ((hosts.isReadonly(host) || safety.readonly) && risk.level !== 'low') throw fail('Read-only host denies this command.', 'DENIED');
    if (safety.policy === 'never' && (requireApproval || risk.level !== 'low')) throw fail('Approval policy is never; this operation is denied.', 'DENIED');
    if (requireChecks && !checksFor(host).length) throw fail('Configure target checks for this logical host before requesting verified execution.', 'TARGET_CHECK_REQUIRED');
    if (checksFor(host).length) assertTargetCommandContext(command);
  }
  async function withContext(request, fn) {
    const { host, exec, sessionId, resetInput = false } = request;
    if (!hosts.isAllowed(host)) throw fail('Host is not allowed by allowHosts.', 'DENIED');
    if (!sessionId) {
      if (host.viaHost) throw fail('A cluster shortcut must use its actual owned PTY, not entrance SSH exec.', 'TARGET_PTY_REQUIRED');
      if (resetInput) throw fail('reset_input requires a PTY session.', 'TARGET_RESET_INVALID');
      return fn(null, exec);
    }
    if (!manager?.withVerifiedLease) throw fail('Verified PTY execution is unavailable.', 'TARGET_PTY_UNAVAILABLE');
    const described = manager.describe(exec.agent, sessionId);
    if (described.host !== host.name) throw fail('PTY session is bound to a different logical host.', 'TARGET_HOST_MISMATCH');
    if (described.connectionDigest !== targetConnectionDigest(host)) throw fail('The owned PTY belongs to an older/different connection or route; reconnect the logical target explicitly.', 'TARGET_CONNECTION_CHANGED');
    if (request.workdir !== undefined) throw fail('PTY target checks use the actual current working directory, not an exec workdir override.', 'TARGET_WORKDIR_INVALID');
    if (resetInput) {
      await authorize({ host, exec, command: 'interrupt foreground input/program and clear the partial PTY line (Ctrl-C / Ctrl-U)',
        toolName: request.toolName ?? 'remote_target_check', description: 'Explicit PTY readiness reset; may interrupt an existing foreground operation', mutating: true, requireApproval: true });
      const current = await snapshot(request);
      const safety = resolveSafetyProfile(config, current.host);
      if (hosts.isReadonly(current.host) || safety.readonly || safety.policy === 'never') throw fail('Current policy forbids resetting this PTY.', 'DENIED');
      if (manager.describe(exec.agent, sessionId).connectionDigest !== targetConnectionDigest(current.host)) throw fail('PTY route changed before reset.', 'TARGET_CONNECTION_CHANGED');
    }
    return manager.withVerifiedLease({ agent: exec.agent, sessionId, signal: exec.signal, resetInput }, async lease => {
      const linked = { ...exec, signal: lease.signal };
      return fn(lease, linked);
    });
  }
  async function authorizeChecks(host, exec, checks, toolName) {
    const decisions = [];
    for (const check of checks) {
      const risk = riskOf(approval, check.command, host);
      if (risk.level === 'high') throw fail('A target check must not be statically mutating.', 'TARGET_CHECK_INVALID');
      decisions.push(await authorize({ host, exec, command: check.command, toolName,
        requireApproval: risk.level !== 'low', description: `Read configured target fact ${check.name}; expected value is ${JSON.stringify(check.expected)}` }));
    }
    return decisions;
  }
  async function validateProbeDispatch(request, checks, decisions) {
    const current = await snapshot(request);
    const safety = resolveSafetyProfile(config, current.host);
    for (const [index, check] of checks.entries()) {
      const risk = riskOf(approval, check.command, current.host);
      if (risk.denied || risk.level === 'high' || ((hosts.isReadonly(current.host) || safety.readonly || safety.policy === 'never') && risk.level !== 'low')) throw fail('Current policy denies the configured probe.', 'DENIED');
      if ((safety.policy === 'always' || risk.level !== 'low') && decisions[index]?.outcome !== 'allowed-once') throw fail('Probe approval requirements changed; request again.', 'DENIED');
    }
  }
  async function run(request, exec, lease, checks, command) {
    const script = buildTargetScript(checks, command);
    const timeoutMs = request.timeoutMs ?? timeoutDefault;
    let result;
    let output;
    let mirror;
    if (!request.onData && live?.begin) {
      try { mirror = live.begin({ sessionId: exec.agent?.session?.id ?? exec.agent?.id ?? 'unknown', host: request.host.name,
        tool: request.toolName ?? 'remote_target_check', command: command ?? 'configured target facts', kind: 'exec' }); } catch { /* optional mirror */ }
    }
    const onData = request.onData ?? (mirror ? event => { try { mirror.output(event?.stream, event?.chunk); } catch { /* mirror cannot break proof */ } } : undefined);
    try {
    if (lease) {
      result = await runVerifiedPty({ send: lease.send, command: script.command, signal: exec.signal, timeoutMs,
        maxBytes, isComplete: output => targetOutputComplete(output, script.nonce), onData });
      output = result.output;
    } else {
      // Native exec has no persistent shell state. Force a known POSIX parser
      // for both checks and action; an unsupported login shell must not partly
      // interpret guard syntax and accidentally run the action.
      const quoted = "'" + script.command.replaceAll("'", "'\\''") + "'";
      result = await transport.exec(request.host, { command: `/bin/sh -c ${quoted}`, workdir: request.workdir,
        timeoutMs, maxBytes, signal: exec.signal, ...(onData ? { onData } : {}) });
      output = result.stdout ?? '';
    }
    exec.signal?.throwIfAborted();
    let evidence = parseTargetOutput(output, script.nonce, checks);
    const failedProof = result.timedOut || result.truncated || result.signal || (lease && !result.complete) ||
      (!lease && evidence.status === 'passed' && (command === undefined ? result.code !== 0 : result.code !== evidence.exitCode));
    if (failedProof) evidence = { status: 'unknown', checks: checks.map(check => ({ name: check.name, expected: check.expected, status: 'unknown' })), actionExecuted: null };
    const actionOutput = evidence.actionOutput ?? '';
    delete evidence.actionOutput;
    evidence = { ...evidence, checks: evidence.checks.map((check, i) => ({ ...check, command: checks[i].command })),
      context: lease ? 'owned-pty-subshell' : 'ssh-exec-subshell', checkedAt: Date.now(), actionAttempted: command !== undefined };
    try { mirror?.end({ code: evidence.exitCode ?? result.code ?? (evidence.status === 'passed' ? 0 : -1), durationMs: result.durationMs,
      ...(evidence.status !== 'passed' ? { error: `Target evidence ${evidence.status}` } : {}) }); } catch { /* optional mirror */ }
    return { result, evidence, output: actionOutput };
    } catch (error) { try { mirror?.end({ error: 'Target execution did not complete' }); } catch { /* optional mirror */ } throw error; }
  }
  async function check(request) {
    request = { ...request, expectedConnectionDigest: request.expectedConnectionDigest ?? targetConnectionDigest(request.host) };
    const active = await snapshot(request);
    request = { ...request, host: active.host, expectedChecksHash: request.expectedChecksHash ?? targetChecksDigest(active.checks) };
    const checks = active.checks;
    if (!checks.length) throw fail('No target checks configured for this logical host.', 'TARGET_CHECK_REQUIRED');
    // Validate framing before any remote operation or intrusive reset.
    buildTargetScript(checks);
    return withContext(request, async (lease, exec) => {
      const decisions = await authorizeChecks(request.host, exec, checks, request.toolName ?? 'remote_target_check');
      await validateProbeDispatch(request, checks, decisions);
      const { evidence } = await run(request, exec, lease, checks);
      const latest = await snapshot(request);
      if (JSON.stringify(checks) !== JSON.stringify(latest.checks)) throw fail('Target checks changed while being inspected; do not reuse this evidence.', 'TARGET_CONFIG_CHANGED');
      return { host: request.host.name, ...evidence };
    });
  }
  async function execute(request) {
    request = { ...request, expectedConnectionDigest: request.expectedConnectionDigest ?? targetConnectionDigest(request.host) };
    const active = await snapshot(request);
    request = { ...request, host: active.host, expectedChecksHash: request.expectedChecksHash ?? targetChecksDigest(active.checks) };
    const { host, command, requireChecks = false, requireApproval = false } = request;
    validateAction(host, command, requireChecks, requireApproval);
    const checks = active.checks;
    if (!checks.length) {
      if (host.viaHost || request.sessionId) throw fail('Verified PTY execution requires checks for the logical host; never fall back to entrance SSH.', 'TARGET_PTY_REQUIRED');
      const decision = await authorize({ ...request, exec: request.exec, requireApproval });
      await dispatchCheck({ ...request, expectedChecksHash: targetChecksDigest(checks), approvedOnce: decision.outcome === 'allowed-once' });
      return transport.exec(host, { command, workdir: request.workdir, timeoutMs: request.timeoutMs ?? timeoutDefault,
        maxBytes, signal: request.exec.signal, ...(request.onData ? { onData: request.onData } : {}) });
    }
    buildTargetScript(checks, command);
    return withContext(request, async (lease, exec) => {
      const decisions = await authorizeChecks(host, exec, checks, request.toolName);
      await validateProbeDispatch(request, checks, decisions);
      const preliminary = (await run(request, exec, lease, checks)).evidence;
      if (preliminary.status !== 'passed') throw fail(`Configured target checks ${preliminary.status}; no action submitted.`, 'TARGET_CHECK_FAILED', preliminary);
      await authorize({ ...request, exec, requireApproval: requireApproval || riskOf(approval, command, host).level !== 'low', targetEvidence: preliminary });
      exec.signal?.throwIfAborted();
      const latest = await snapshot(request);
      if (JSON.stringify(checks) !== JSON.stringify(latest.checks)) throw fail('Target-check definitions changed during approval; request a new operation.', 'TARGET_CONFIG_CHANGED');
      await validateProbeDispatch(request, checks, decisions);
      validateAction(latest.host, command, requireChecks, requireApproval);
      // A second guard evaluates checks and action in one actual command context.
      const { result, evidence, output } = await run(request, exec, lease, checks, command);
      if (evidence.status !== 'passed' || evidence.actionExecuted !== true || !Number.isSafeInteger(evidence.exitCode)) {
        throw fail(`Target guard ${evidence.status}; action completion is not proven. Inspect current state before retry.`, evidence.status === 'unknown' ? 'TARGET_OUTCOME_UNKNOWN' : 'TARGET_CHECK_FAILED', evidence);
      }
      return { code: evidence.exitCode, stdout: output, stderr: result.stderr ?? '', timedOut: false,
        truncated: false, signal: null, targetEvidence: evidence, durationMs: result.durationMs ?? 0 };
    });
  }
  return { requires, checksFor, configuredChecksFor, refresh, dispatchCheck, check, execute };
}
