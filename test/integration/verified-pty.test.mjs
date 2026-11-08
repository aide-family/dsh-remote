import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startSshServer } from '../fixtures/ssh-server.mjs';
import { createSshTransport } from '../../lib/ssh/transport.js';
import { createShellManager } from '../../lib/terminal/manager.js';
import { createTerminalRelay } from '../../lib/terminal/relay.js';
import { runVerifiedPty } from '../../lib/terminal/verified-exec.js';
import { buildTargetScript, parseTargetOutput, targetOutputComplete } from '../../lib/target-checks.js';

const config = { terminalIdleSilenceMs: 50, terminalTimeoutMs: 2000, terminalStartupTimeoutMs: 5000, terminalMaxReadBytes: 65536, userTerminalReconnectAttempts: 0 };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
function hostOf(server) { return { id: 'config:fixture', name: 'fixture', host: server.host, port: server.port, username: server.username, identityFile: server.privateKeyPath }; }
function transportOf() { return createSshTransport({ connectTimeoutMs: 5000, knownHostsPolicy: 'insecure', logger: quiet }); }
async function verified(context, checks, action) {
  const script = buildTargetScript(checks, action);
  const result = await runVerifiedPty({ ...context, command: script.command, timeoutMs: 2000, maxBytes: 65536, isComplete: output => targetOutputComplete(output, script.nonce) });
  return { result, parsed: parseTargetOutput(result.output, script.nonce, checks) };
}

test('real POSIX fixture: reset proof, long action, current environment, mismatch fail-stop', async t => {
  const server = await startSshServer(); const transport = transportOf();
  const manager = createShellManager({ transport, config, logger: quiet });
  t.after(async () => { await manager.dispose(); transport.dispose(); await server.close(); });
  const agent = {}; const host = hostOf(server); const { sessionId } = await manager.open({ agent, host });
  const request = { agent, sessionId };
  await manager.send({ ...request, text: 'export DSH_FIXTURE_TARGET=demo-current' });
  const checks = [{ name: 'environment', command: "printf '%s' \"$DSH_FIXTURE_TARGET\"", expected: 'demo-current' }];
  const passed = await manager.withVerifiedLease({ ...request, resetInput: true }, context => verified(context, checks, 'sleep 0.2; printf verified-action'));
  assert.equal(passed.result.complete, true);
  assert.equal(passed.result.waitReason, 'protocol_complete');
  assert.equal(passed.parsed.status, 'passed');
  assert.equal(passed.parsed.actionExecuted, true);
  assert.equal(passed.parsed.exitCode, 0);
  const mismatch = await manager.withVerifiedLease(request, context => verified(context, [{ ...checks[0], expected: 'wrong' }], 'printf MUST_NOT_EXECUTE'));
  assert.equal(mismatch.parsed.status, 'mismatch');
  assert.equal(mismatch.parsed.actionExecuted, false);
  assert.equal(mismatch.result.output.includes('MUST_NOT_EXECUTE'), false);
});

test('native operator input cancels approval-held lease before takeover, never logs raw bytes', async t => {
  const server = await startSshServer(); const transport = transportOf();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-verified-relay-')); const socketPath = join(dir, 'terminal.sock');
  const host = hostOf(server); const audit = [];
  const relay = createTerminalRelay({ transport, config, logger: quiet, socketPath, audit: { record(entry) { audit.push(entry); } }, hosts: {
    async find() { return host; }, isAllowed() { return true; }, isReadonly() { return false; },
  } });
  await relay.start();
  const manager = createShellManager({ transport, relay, config, logger: quiet });
  let socket;
  t.after(async () => { socket?.destroy(); await manager.dispose(); await relay.dispose(); transport.dispose(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const agent = { session: { id: 'verified-conversation' } };
  const { sessionId } = await manager.open({ agent, host });
  socket = connect(socketPath); socket.on('error', () => {});
  await once(socket, 'connect'); socket.write(JSON.stringify({ host: 'fixture', sessionId: 'verified-conversation' }) + '\n');
  // Relay sends replay immediately after accepting handshake, so this fences attach.
  await once(socket, 'data');
  let approved;
  const entered = new Promise(resolve => { approved = resolve; });
  const operation = manager.withVerifiedLease({ agent, sessionId, resetInput: true }, async context => {
    approved();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    await context.send('printf SHOULD_NOT_BE_SUBMITTED', { isComplete: () => false });
  });
  await entered;
  const sentinel = 'OPERATOR_INPUT_PRIVATE_SENTINEL';
  socket.write(JSON.stringify({ t: 'i', d: Buffer.from(`echo ${sentinel}\r`).toString('base64') }) + '\n');
  await assert.rejects(operation, { name: 'AbortError' });
  await assert.rejects(manager.withVerifiedLease({ agent, sessionId }, () => {}), { code: 'CONTEXT_RESET_REQUIRED' });
  assert.equal(JSON.stringify(audit).includes(sentinel), false);
  assert.equal(manager.read({ agent, sessionId }).text.includes('SHOULD_NOT_BE_SUBMITTED'), false);
});
