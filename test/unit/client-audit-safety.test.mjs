import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
function setup() {
  let registration;
  const instrumented = source.replace('    return plugin;', '    return { auditOutcomeLabel, auditOutcomeClass, auditRecoveryDetails, auditHealthNotice, auditExportText, readAuditPages };');
  assert.notEqual(instrumented, source);
  vm.runInNewContext(instrumented, { window: { __ModuleLoader__: { load(value) { registration = value; } } } }, { timeout: 1000 });
  return registration.factory(() => ({ createElement(type, props, ...children) { return { type, props: props || {}, children }; } }));
}

test('audit outcome labels distinguish failure and uncertainty without color-only semantics', () => {
  const ui = setup();
  assert.equal(ui.auditOutcomeLabel('ok'), '成功');
  assert.equal(ui.auditOutcomeLabel('failed'), '执行失败');
  assert.equal(ui.auditOutcomeLabel('unknown'), '结果未知');
  assert.equal(ui.auditOutcomeLabel('timed_out'), '超时');
  assert.equal(ui.auditOutcomeLabel('cancelled'), '已取消');
  assert.equal(ui.auditOutcomeClass('unknown'), 'dshr-warn');
  assert.notEqual(ui.auditOutcomeClass('failed'), 'dshr-ok');
});

test('audit health failure renders a persistent accessible notice, not only a toast', () => {
  const ui = setup();
  assert.equal(ui.auditHealthNotice({ status: 'ok', persistent: true, failedWrites: 0 }), null);
  const node = ui.auditHealthNotice({ status: 'degraded', persistent: true, failedWrites: 1, lastError: 'write failed' });
  assert.equal(node.props.role, 'status');
  assert.equal(node.props['aria-live'], 'polite');
  assert.match(node.children.join(''), /审计持久化异常/);
  assert.match(ui.auditHealthNotice({ status: 'memory-only', persistent: false }).children.join(''), /仅保存在内存/);
});

test('JSON CSV TXT audit exports retain correlation, exit and recovery/verification fields', () => {
  const ui = setup();
  const entry = { tool: 'remote_edit', outcome: 'verification_failed', detail: '/etc/demo.conf', operationId: 'op-fixture', callId: 'call-fixture', sessionId: 'session-fixture', agentId: 'agent-fixture', exitCode: 2, summary: 'validation failed', backupId: 'backup-fixture', beforeVersion: 'before', afterVersion: 'after', verification: { status: 'failed', exitCode: 2 } };
  for (const format of ['json', 'csv', 'txt']) {
    const exported = ui.auditExportText(format, [entry]);
    for (const fact of ['op-fixture', 'call-fixture', 'session-fixture', 'agent-fixture', 'backup-fixture', 'before', 'after']) assert.ok(exported.includes(fact), `${format} missing ${fact}`);
    assert.ok(exported.includes('verification'));
    assert.doesNotMatch(exported, /\[object Object\]/);
  }
  assert.match(ui.auditRecoveryDetails(entry), /exitCode: 2/);
});

test('audit export paginates beyond the old 500-row limit and checks stable history', async () => {
  const ui = setup();
  const rows = Array.from({ length: 1100 }, (_, i) => ({ operationId: 'op-' + i, id: i }));
  const calls = [];
  const result = await ui.readAuditPages(async params => {
    calls.push(params);
    return { total: rows.length, entries: rows.slice(params.offset || 0, (params.offset || 0) + params.limit) };
  }, 'fixture');
  assert.equal(result.length, 1100);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(params => params.host === 'fixture' && params.full === true));
});

test('changing or oversized audit exports fail explicitly without partial file claims', async () => {
  const ui = setup();
  await assert.rejects(ui.readAuditPages(async () => ({ total: 10001, entries: [] })), /10000/);
  let calls = 0;
  await assert.rejects(ui.readAuditPages(async () => {
    calls++;
    return { total: 1, entries: [{ operationId: calls === 1 ? 'original' : 'new' }] };
  }), /发生变化/);
  assert.match(ui.auditRecoveryDetails({ afterVersion: null }), /afterVersion: unknown/);
  assert.equal(ui.auditHealthNotice({ status: 'ok', persistent: true, failedWrites: 2 }), null);
});
