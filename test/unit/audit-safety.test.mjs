import assert from 'node:assert/strict';
import test from 'node:test';
import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuditLog } from '../../lib/audit.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'audit-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, filePath: join(root, 'audit.jsonl') };
}

test('runtime count and byte bounds apply before restart with private disk permissions', async t => {
  const { root, filePath } = await fixture(t);
  const audit = createAuditLog({ filePath, limit: 3, maxBytes: 2048 });
  for (let i = 0; i < 20; i++) audit.record({ tool: 'remote_exec', detail: `cmd-${i} ` + 'x'.repeat(80), outcome: 'ok' });
  assert.ok(audit.size <= 3);
  const disk = await readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(disk) <= 2048);
  assert.ok(disk.trim().split('\n').length <= 3);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ['audit.jsonl']);
});

test('large newest call is trimmed instead of clearing the audit history', async t => {
  const { filePath } = await fixture(t);
  const audit = createAuditLog({ filePath, maxBytes: 1024 });
  audit.record({ tool: 'remote_exec', detail: 'old', outcome: 'ok' });
  audit.record({ tool: 'remote_exec', detail: 'x'.repeat(16000), outcome: 'failed' });
  const records = audit.list({ full: true });
  assert.equal(records[0].outcome, 'failed');
  assert.equal(records[0].truncated, true);
  assert.ok(audit.size >= 1);
  assert.ok(Buffer.byteLength(await readFile(filePath, 'utf8')) <= 1024);
});

test('age retention runs on access and is persisted during operation', async t => {
  const { filePath } = await fixture(t);
  let now = Date.now();
  const audit = createAuditLog({ filePath, retentionDays: 1, now: () => now });
  audit.record({ tool: 'remote_exec', detail: 'expires', outcome: 'ok' });
  now += 2 * 86400000;
  assert.equal(audit.list().length, 0);
  assert.equal(await readFile(filePath, 'utf8'), '');
});

test('write failure is visible, recoverable and does not leak error subjects', async t => {
  const { root } = await fixture(t);
  const blocked = join(root, 'blocked');
  await writeFile(blocked, 'not a directory');
  const filePath = join(blocked, 'audit.jsonl');
  const audit = createAuditLog({ filePath });
  audit.record({ tool: 'remote_exec', outcome: 'unknown', detail: 'TOKEN=private-value' });
  assert.equal(audit.health().status, 'degraded');
  assert.ok(audit.health().failedWrites > 0);
  assert.doesNotMatch(audit.health().lastError, /private-value|blocked/);
  // The resolved fixture path is deliberately the file created above.
  await rm(blocked); await mkdir(blocked);
  audit.record({ tool: 'remote_exec', detail: 'next', outcome: 'ok' });
  assert.equal(audit.health().status, 'ok');
  assert.ok(audit.health().failedWrites > 0);
  assert.equal(audit.health().lastError, null);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /private-value/);
});

test('interleaved stores merge new operations without overwriting or reviving cleared history', async t => {
  const { filePath } = await fixture(t);
  const a = createAuditLog({ filePath });
  const b = createAuditLog({ filePath });
  a.record({ tool: 'remote_exec', detail: 'from-a', outcome: 'ok' });
  await b.load();
  b.record({ tool: 'remote_exec', detail: 'from-b', outcome: 'ok' });
  a.record({ tool: 'remote_exec', detail: 'from-a-next', outcome: 'ok' });
  let disk = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(disk.length, 3);
  assert.equal(new Set(disk.map(row => row.operationId)).size, 3);
  assert.equal(new Set(disk.map(row => row.id)).size, 3);
  assert.equal(b.clear().cleared, true);
  a.record({ tool: 'remote_exec', detail: 'after-clear', outcome: 'ok' });
  disk = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(disk.length, 1);
  assert.equal(disk[0].detail, 'after-clear');
});

test('live writer lock fails visibly without eviction and pending calls recover', async t => {
  const { root, filePath } = await fixture(t);
  const lockPath = join(root, '.audit.jsonl.lock');
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
  const audit = createAuditLog({ filePath });
  audit.record({ tool: 'remote_exec', detail: 'pending', outcome: 'unknown' });
  assert.equal(audit.health().status, 'degraded');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  // Only remove the exact test-created lock after checking its owner.
  await rm(lockPath);
  audit.record({ tool: 'remote_exec', detail: 'after-lock', outcome: 'ok' });
  assert.equal(audit.health().status, 'ok');
  const disk = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(disk.length, 2);
});

test('a hardlinked temp is rejected before truncating another local file', async t => {
  const { root, filePath } = await fixture(t);
  const protectedPath = join(root, 'protected.txt');
  await writeFile(protectedPath, 'must remain unchanged');
  await link(protectedPath, join(root, '.audit.jsonl.tmp'));
  const audit = createAuditLog({ filePath });
  audit.record({ tool: 'remote_exec', detail: 'safe', outcome: 'ok' });
  assert.equal(await readFile(protectedPath, 'utf8'), 'must remain unchanged');
  assert.ok(audit.health().failedWrites >= 1);
  assert.equal(await readFile(protectedPath, 'utf8'), 'must remain unchanged');
});

test('common secrets are redacted on record and legacy reload while null versions remain explicit', async t => {
  const { filePath } = await fixture(t);
  const audit = createAuditLog({ filePath });
  audit.record({ tool: 'remote_exec', outcome: 'unknown', detail: 'TOKEN=never-record-me curl https://user:private@example.com', afterVersion: null, backupId: 'backup-fixture', verification: { status: 'unknown', exitCode: null } });
  const restored = createAuditLog({ filePath });
  await restored.load();
  const entry = restored.list({ full: true })[0];
  assert.equal(entry.afterVersion, null);
  assert.equal(entry.verification.status, 'unknown');
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /never-record-me|user:private/);
  entry.verification.status = 'passed';
  assert.equal(restored.list()[0].verification.status, 'unknown');
});
