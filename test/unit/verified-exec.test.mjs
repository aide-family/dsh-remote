import assert from 'node:assert/strict';
import test from 'node:test';
import { createPtySession } from '../../lib/terminal/pty-session.js';
import { runVerifiedPty } from '../../lib/terminal/verified-exec.js';
import { createShellManager } from '../../lib/terminal/manager.js';

class FakePty {
  data = new Set(); exits = new Set(); writes = []; signals = []; current = { kind: 'running' }; proof = null;
  write(text) { this.writes.push(text); this.onWrite?.(text); }
  onData(fn) { this.data.add(fn); return () => this.data.delete(fn); }
  onExit(fn) { this.exits.add(fn); return () => this.exits.delete(fn); }
  emit(text) { for (const fn of [...this.data]) fn(text); }
  exit() { this.current = { kind: 'exited', exitCode: 0 }; for (const fn of [...this.exits]) fn({ code: 0 }); }
  status() { return this.current; }
  signal(name) { this.signals.push(name); }
  resize() {}
  async close() { this.exit(); }
}
const config = { terminalIdleSilenceMs: 30, terminalTimeoutMs: 200, terminalStartupTimeoutMs: 1000, terminalMaxReadBytes: 4096 };
const marker = output => output.includes('\nDONE\n');
function sender(session) { return (command, options) => session.startSend({ ...options, text: command }).done; }

test('verified runner waits beyond ordinary idle for explicit completion', async () => {
  const pty = new FakePty();
  const session = createPtySession({ pty, config });
  pty.onWrite = () => { pty.emit('working\n'); setTimeout(() => pty.emit('\nDONE\n'), 100); };
  const result = await runVerifiedPty({ send: sender(session), command: 'action', timeoutMs: 500, isComplete: marker });
  assert.equal(result.complete, true);
  assert.equal(result.waitReason, 'protocol_complete');
  assert.match(result.output, /working/);
  await session.close();
});

test('truncation and timeout never constitute protocol proof', async () => {
  const pty = new FakePty(); const session = createPtySession({ pty, config });
  pty.onWrite = () => pty.emit('x'.repeat(100) + '\nDONE\n');
  const result = await runVerifiedPty({ send: sender(session), command: 'action', timeoutMs: 80, maxBytes: 40, isComplete: marker });
  assert.equal(result.complete, false); assert.equal(result.truncated, true); assert.equal(result.timedOut, true);
  assert.ok(Buffer.byteLength(result.output) <= 40);
  await session.close();
});

test('UTF-8 output and mirror taps remain bounded; a failing tap cannot break proof', async () => {
  const pty = new FakePty(); const session = createPtySession({ pty, config });
  pty.onWrite = () => pty.emit('🙂🙂\nDONE\n');
  let mirrored = '';
  const result = await runVerifiedPty({ send: sender(session), command: 'action', maxBytes: 3, timeoutMs: 50, isComplete: marker,
    onData(event) { mirrored += event.chunk; throw new Error('mirror failure'); } });
  assert.equal(result.complete, false);
  assert.ok(Buffer.byteLength(result.output) <= 3);
  assert.ok(Buffer.byteLength(mirrored) <= 3);
  pty.onWrite = () => pty.emit('\nDONE\n');
  const successful = await runVerifiedPty({ send: sender(session), command: 'action', isComplete: marker, onData() { throw new Error('mirror failure'); } });
  assert.equal(successful.complete, true);
  await session.close();
});

test('runner rejects missing completion predicate before writing and ignores old output', async () => {
  const pty = new FakePty(); const session = createPtySession({ pty, config, initialOutput: '\nDONE\n' });
  await assert.rejects(runVerifiedPty({ send: sender(session), command: 'action' }), { code: 'PROTOCOL_REQUIRED' });
  assert.equal(pty.writes.length, 0);
  pty.onWrite = () => pty.emit('not complete\n');
  const result = await runVerifiedPty({ send: sender(session), command: 'action', timeoutMs: 60, isComplete: marker });
  assert.equal(result.complete, false);
  await session.close();
});

test('external cancellation and shell exit invalidate proof', async () => {
  const pty = new FakePty(); const session = createPtySession({ pty, config });
  const controller = new AbortController();
  pty.onWrite = () => controller.abort();
  await assert.rejects(runVerifiedPty({ send: sender(session), command: 'action', signal: controller.signal, isComplete: marker }), { name: 'AbortError' });
  pty.onWrite = () => pty.exit();
  const result = await runVerifiedPty({ send: sender(session), command: 'action', isComplete: marker });
  assert.equal(result.complete, false); assert.equal(result.waitReason, 'session_exit');
  await session.close();
});

test('manager fences owner, fails unknown context without reset, and holds one lease', async () => {
  const pty = new FakePty();
  pty.onWrite = text => {
    const nonce = /dsh_ready_([a-f0-9]{32})\(\)/u.exec(text)?.[1];
    if (nonce) pty.emit(`\nDSH_READY_${nonce}\n`);
    else if (text.includes('action')) pty.emit('\nDONE\n');
  };
  const manager = createShellManager({ transport: { async openPty() { return pty; } }, config });
  const agent = {}; const { sessionId } = await manager.open({ agent, host: { name: 'test', host: 'example.invalid' } });
  const request = { agent, sessionId };
  await assert.rejects(manager.withVerifiedLease({ ...request, agent: {} }, () => {}), { code: 'FOREIGN_SESSION' });
  await assert.rejects(manager.withVerifiedLease(request, () => {}), { code: 'CONTEXT_RESET_REQUIRED' });
  assert.equal(pty.writes.length, 0);
  await manager.withVerifiedLease({ ...request, resetInput: true }, async context => {
    await assert.rejects(manager.send({ ...request, text: 'other' }), { code: 'VERIFIED_LEASE_BUSY' });
    await assert.rejects(manager.withVerifiedLease(request, () => {}), { code: 'VERIFIED_LEASE_BUSY' });
    const result = await runVerifiedPty({ ...context, command: 'action', isComplete: marker });
    assert.equal(result.complete, true);
  });
  assert.equal(pty.writes[0], '\u0003\u0015');
  // A positively complete command preserves readiness on this exact channel.
  await manager.withVerifiedLease(request, async context => { assert.equal((await runVerifiedPty({ ...context, command: 'action', isComplete: marker })).complete, true); });
  await manager.send({ ...request, text: 'ordinary' });
  await assert.rejects(manager.withVerifiedLease(request, () => {}), { code: 'CONTEXT_RESET_REQUIRED' });
  await manager.dispose();
});
