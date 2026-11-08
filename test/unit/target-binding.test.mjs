import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createTargetController } from '../../lib/target-controller.js';
import { connectionBinding, targetConnectionDigest, targetChecksDigest } from '../../lib/target-binding.js';

const CHECK_A = [{ name: 'target', command: 'printf cluster-A', expected: 'cluster-A' }];
const CHECK_B = [{ name: 'target', command: 'printf cluster-B', expected: 'cluster-B' }];
const ACTION = 'printf action-ran';
function fixture({ checks = CHECK_A, refreshMutation, approvalMutation, probeApprovalMutation, manager, profiles = [] } = {}) {
  const initial = { id: 'config:demo', name: 'demo', host: 'example.invalid', port: 22, username: 'ops', tags: [] };
  let current = structuredClone(initial), managed = structuredClone(checks), allowed = true, refreshCount = 0;
  const calls = { total: 0, probes: 0, actions: 0, approvals: 0, stdout: [] };
  const control = { setHost(value) { current = value; }, host() { return current; }, setChecks(value) { managed = structuredClone(value); }, deny() { allowed = false; } };
  const transport = { async exec(_host, options) {
    calls.total++; calls[options.command.includes('ACTION_START') ? 'actions' : 'probes']++;
    // Generated protocol plus synthetic readonly printf commands only.
    assert.ok(options.command.startsWith('/bin/sh -c '));
    const executed = spawnSync('/bin/sh', ['-c', options.command], { encoding: 'utf8', timeout: 2000, maxBuffer: 512 * 1024 });
    if (executed.error) throw executed.error;
    calls.stdout.push(executed.stdout);
    return { code: executed.status, stdout: executed.stdout, stderr: executed.stderr, signal: executed.signal, timedOut: false, truncated: false, durationMs: 0 };
  } };
  const approval = {
    assessCommand(command) { return { level: command === ACTION ? 'high' : 'low', verb: 'printf' }; },
    async authorize(request) { calls.approvals++; if (request.subject === ACTION) approvalMutation?.(control); else probeApprovalMutation?.(control); return { allowed: true, outcome: 'allowed-once' }; },
  };
  const config = { policy: 'auto', profiles, readonlyHosts: [], denyCommandPatterns: [], maxOutputBytes: 65536 };
  const targets = createTargetController({ config, transport, approval, manager,
    hosts: { async find(name) { assert.equal(name, initial.name); return current; }, isAllowed() { return allowed; }, isReadonly(host) { return host.readonly === true; } },
    managedChecks: () => managed, refreshManaged: async () => { refreshMutation?.(control, ++refreshCount); } });
  const request = { host: initial, exec: { agent: { id: 'fixture-agent' } }, command: ACTION, requireChecks: true, requireApproval: true,
    expectedChecksHash: targetChecksDigest(checks), expectedConnectionDigest: targetConnectionDigest(initial), toolName: 'remote_exec' };
  return { targets, request, calls, control, config };
}
const noDispatch = calls => { assert.equal(calls.total, 0, 'changed binding must prevent even probe dispatch'); assert.equal(calls.probes, 0); assert.equal(calls.actions, 0); };
const onlyProbe = calls => { assert.equal(calls.total, 1); assert.equal(calls.probes, 1); assert.equal(calls.actions, 0); assert.equal(calls.stdout.some(output => output.includes('action-ran')), false); };

test('connection identity includes exact shortcut entry and ordered initialization actions', () => {
  const host = { id: 'managed:cluster', name: 'cluster', host: 'example.invalid', viaHost: 'entry-a', actions: [{ type: 'command', value: 'select-cluster a' }] };
  assert.equal(connectionBinding(host), connectionBinding(structuredClone(host)));
  assert.notEqual(targetConnectionDigest(host), targetConnectionDigest({ ...host, viaHost: 'entry-b' }));
  assert.notEqual(targetConnectionDigest(host), targetConnectionDigest({ ...host, actions: [{ type: 'command', value: 'select-cluster b' }] }));
  assert.deepEqual(JSON.parse(connectionBinding({ name: 'direct', host: 'example.invalid' })).slice(6), [null, []]);
});

test('fixed checks hash rejects refresh drift at execute entry with zero probe/action/approval calls', async () => {
  const f = fixture({ refreshMutation(control, count) { if (count === 1) control.setChecks(CHECK_B); } });
  await assert.rejects(f.targets.execute(f.request), { code: 'TARGET_CONFIG_CHANGED' }); noDispatch(f.calls); assert.equal(f.calls.approvals, 0);
});

test('fixed checks hash rejects explicit check entry drift before any transport call', async () => {
  const f = fixture({ refreshMutation(control) { control.setChecks(CHECK_B); } });
  await assert.rejects(f.targets.check({ ...f.request, command: undefined, toolName: 'remote_target_check' }), { code: 'TARGET_CONFIG_CHANGED' }); noDispatch(f.calls);
});

test('check definitions changed during probe approval prevent even preliminary probe dispatch', async () => {
  const f = fixture({ probeApprovalMutation(control) { control.setChecks(CHECK_B); } });
  await assert.rejects(f.targets.execute(f.request), { code: 'TARGET_CONFIG_CHANGED' }); noDispatch(f.calls);
});

test('explicit check route changed during probe approval prevents all transport calls', async () => {
  const f = fixture({ probeApprovalMutation(control) { control.setHost({ ...control.host(), viaHost: 'different-entry', actions: [{ type: 'command', value: 'select-cluster other' }] }); } });
  await assert.rejects(f.targets.check({ ...f.request, command: undefined, toolName: 'remote_target_check' }), { code: 'TARGET_CONNECTION_CHANGED' }); noDispatch(f.calls);
});

test('changed route at entry cannot dispatch a probe or intrusive reset', async () => {
  const f = fixture({ refreshMutation(control) { control.setHost({ ...control.host(), viaHost: 'entry-demo', actions: [{ type: 'command', value: 'select-cluster other' }] }); } });
  await assert.rejects(f.targets.execute(f.request), { code: 'TARGET_CONNECTION_CHANGED' }); noDispatch(f.calls); assert.equal(f.calls.approvals, 0);
});

test('allow/readonly changes at entry reject before all probes and actions', async t => {
  await t.test('allowlist', async () => { const f = fixture({ refreshMutation(control) { control.deny(); } }); await assert.rejects(f.targets.execute(f.request), { code: 'DENIED' }); noDispatch(f.calls); });
  await t.test('readonly', async () => { const f = fixture({ refreshMutation(control) { control.setHost({ ...control.host(), readonly: true }); } }); await assert.rejects(f.targets.execute(f.request), { code: 'DENIED' }); noDispatch(f.calls); });
});

test('check definitions changed during action approval cannot dispatch a guarded action', async () => {
  const f = fixture({ approvalMutation(control) { control.setChecks(CHECK_B); } });
  await assert.rejects(f.targets.execute(f.request), { code: 'TARGET_CONFIG_CHANGED' }); onlyProbe(f.calls);
});

test('routing changed during action approval cannot dispatch a guarded action', async () => {
  const f = fixture({ approvalMutation(control) { control.setHost({ ...control.host(), viaHost: 'new-entry', actions: [{ type: 'command', value: 'select-cluster different' }] }); } });
  await assert.rejects(f.targets.execute(f.request), { code: 'TARGET_CONNECTION_CHANGED' }); onlyProbe(f.calls);
});

test('hard policy changes during action approval use current resolved host metadata', async t => {
  await t.test('readonly', async () => { const f = fixture({ approvalMutation(control) { control.setHost({ ...control.host(), readonly: true }); } }); await assert.rejects(f.targets.execute(f.request), { code: 'DENIED' }); onlyProbe(f.calls); });
  await t.test('allowlist', async () => { const f = fixture({ approvalMutation(control) { control.deny(); } }); await assert.rejects(f.targets.execute(f.request), { code: 'DENIED' }); onlyProbe(f.calls); });
  await t.test('new readonly tag', async () => {
    const profiles = [{ name: 'locked', hosts: [], tags: ['locked'], denyCommandPatterns: [], targetChecks: [], readonly: true }];
    const f = fixture({ profiles, approvalMutation(control) { control.setHost({ ...control.host(), tags: ['locked'] }); } });
    await assert.rejects(f.targets.execute(f.request), { code: 'DENIED' }); onlyProbe(f.calls);
  });
});

test('unchanged binding exercises real POSIX nonce protocol and exactly one action', async () => {
  const f = fixture(); const result = await f.targets.execute(f.request);
  assert.equal(result.code, 0); assert.equal(result.stdout, 'action-ran'); assert.equal(result.targetEvidence.status, 'passed'); assert.equal(result.targetEvidence.actionExecuted, true);
  assert.equal(f.calls.probes, 1); assert.equal(f.calls.actions, 1); assert.equal(f.calls.total, 2);
});

test('old connection digest rejects an owned PTY before leasing or probing', async () => {
  let leases = 0;
  const manager = { describe() { return { host: 'demo', connectionDigest: 'obsolete-route-digest' }; }, async withVerifiedLease() { leases++; throw new Error('Must not lease old PTY'); } };
  const f = fixture({ manager });
  await assert.rejects(f.targets.execute({ ...f.request, sessionId: 'remote-shell-1' }), { code: 'TARGET_CONNECTION_CHANGED' }); noDispatch(f.calls); assert.equal(leases, 0);
});
