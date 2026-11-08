import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { normalizeConfig } from '../../lib/config.js';
import { createApprovalGate } from '../../lib/approval.js';
import { createTargetController } from '../../lib/target-controller.js';
import { createTools } from '../../lib/tools.js';
import { createTargetCheckTool } from '../../lib/target-tools.js';
import { createSshTransport } from '../../lib/ssh/transport.js';
import { startSshServer } from '../fixtures/ssh-server.mjs';

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
// Isolated loopback fixture only; no live inventory, workflow engine or external targets.
async function harness(t, options = {}) {
  const server = await startSshServer();
  const root = await mkdtemp(join(tmpdir(), 'target-runtime-'));
  const identity = join(server.rootDir, 'site-identity');
  const actionFile = join(server.rootDir, 'action-completed');
  await writeFile(identity, 'synthetic-site-a\n');
  const host = { id: 'config:fixture', name: 'fixture', host: server.host, port: server.port, username: server.username, identityFile: server.privateKeyPath };
  const config = normalizeConfig({ includeSshConfig: false, hosts: [host],
    profiles: [{ name: 'fixture-target', hosts: ['fixture'], targetChecks: [{ name: 'site', command: `cat ${shellQuote(identity)}`, expected: 'synthetic-site-a' }] }] });
  const approvals = [];
  const approval = createApprovalGate({ config, ctx: { get: () => ({ request: async request => {
    approvals.push(request);
    if (options.onApproval) return options.onApproval(request, { identity, actionFile, config });
    return 'allowed-once';
  } }) } });
  const transport = createSshTransport({ knownHostsPolicy: 'tofu', knownHostsPath: join(root, 'known-hosts.json') });
  t.after(async () => { transport.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const hosts = { find: async name => name === 'fixture' ? host : undefined, isAllowed: () => true, isReadonly: () => false };
  const targets = createTargetController({ config, transport, approval, hosts });
  const tools = [...createTools({ defineTool, config, transport, hosts, approval, targets, cwdOf: async () => root, backupRoot: join(root, 'backups') }),
    createTargetCheckTool({ defineTool, hosts, targets })];
  const map = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  const exec = { agent: { id: 'fixture-owner' }, callId: 'fixture-call', signal: new AbortController().signal };
  return { config, root, actionFile, identity, approvals, targets, host, hosts, map, exec,
    run: (name, args = {}, execution = exec) => map[name].execute({ host: 'fixture',
      ...(['remote_exec', 'remote_transfer'].includes(name) ? { description: 'Isolated fixture action' } : {}), ...args }, execution) };
}

test('actual SSH target check and guarded exec expose evidence and exact command status', async t => {
  const f = await harness(t);
  const check = await f.run('remote_target_check');
  assert.equal(check.status, 'passed'); assert.equal(check.actionExecuted, false);
  const value = await f.run('remote_exec', { command: 'exit 7', description: 'Fixture nonzero exit' });
  assert.equal(value.exitCode, 7); assert.equal(value.targetEvidence.status, 'passed'); assert.equal(value.targetEvidence.actionExecuted, true);
  assert.match(f.approvals[0].reason, /expected=.*synthetic-site-a.*actual=.*synthetic-site-a/);
  assert.ok(!value.stdout.includes('DSH_TARGET_'));
});

test('target change during approval is caught by same-context guard before mutation', async t => {
  const f = await harness(t, { onApproval: async (_request, state) => { await writeFile(state.identity, 'synthetic-site-b\n'); return 'allowed-once'; } });
  await assert.rejects(f.run('remote_exec', { command: `touch ${shellQuote(f.actionFile)}`, description: 'Must not run on changed site' }), { code: 'TARGET_CHECK_FAILED' });
  await assert.rejects(stat(f.actionFile), { code: 'ENOENT' });
});

test('changed target-check definitions and context overrides never dispatch an action', async t => {
  const f = await harness(t, { onApproval: async (_request, state) => { state.config.profiles[0].targetChecks[0].expected = 'changed-by-operator'; return 'allowed-once'; } });
  await assert.rejects(f.run('remote_exec', { command: `touch ${shellQuote(f.actionFile)}` }), { code: 'TARGET_CONFIG_CHANGED' });
  await assert.rejects(stat(f.actionFile), { code: 'ENOENT' });
  await assert.rejects(f.run('remote_exec', { command: 'ssh other-host reboot' }), /context/);
});

test('revoked allowHosts during approval blocks guard dispatch', async t => {
  let f;
  f = await harness(t, { onApproval: async () => { f.hosts.isAllowed = () => false; return 'allowed-once'; } });
  await assert.rejects(f.run('remote_exec', { command: `touch ${shellQuote(f.actionFile)}` }), { code: 'DENIED' });
  await assert.rejects(stat(f.actionFile), { code: 'ENOENT' });
});

test('configured target checks never silently downgrade to SFTP for mutations or transfers', async t => {
  const f = await harness(t);
  for (const [name, args] of [
    ['remote_write', { path: f.actionFile, content: 'unsafe' }],
    ['remote_edit', { path: f.identity, old_string: 'site-a', new_string: 'site-b' }],
    ['remote_restore', { backup_id: 'not-loaded' }],
    ['remote_transfer', { direction: 'download', remote_path: f.identity, local_path: 'download.txt', overwrite: true }],
    ['remote_transfer', { direction: 'upload', remote_path: f.identity, local_path: 'upload.txt', overwrite: true }],
  ]) await assert.rejects(f.run(name, args), { code: 'TARGET_SFTP_UNSUPPORTED' });
  const value = await f.run('remote_read', { path: '/site-identity' });
  assert.equal(value.targetVerification, 'not-applied-sftp');
  assert.match(f.map.remote_read.output.render({}, value)[0].text, /not target-verified/);
  assert.equal(f.approvals.length, 0);
});
