import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTerminalRelay } from '../../lib/terminal/relay.js'
import { createShellManager } from '../../lib/terminal/manager.js'

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shared-release-'))
  const host = { id: 'fixture', name: 'fixture', host: '127.0.0.1', port: 22 }
  const data = new Set(), exit = new Set()
  const raw = { writes: [], signals: [], resizes: [], closed: false,
    onData(fn) { data.add(fn); return () => data.delete(fn) }, onExit(fn) { exit.add(fn); return () => exit.delete(fn) },
    write(text) { this.writes.push(text) }, signal(name) { this.signals.push(name) }, resize(...size) { this.resizes.push(size) },
    status() { return this.closed ? { kind: 'exited', exitCode: 0 } : { kind: 'running' } },
    async close() { this.closed = true; for (const fn of [...exit]) fn({ code: 0 }) },
  }
  const config = { terminalIdleSilenceMs: 30, terminalTimeoutMs: 10000, terminalStartupTimeoutMs: 500, userTerminalTtlMs: 10000 }
  const transport = { async openPty() { return raw } }
  const relay = createTerminalRelay({ transport, hosts: { async find() { return host }, isAllowed() { return true } }, config, socketPath: join(directory, 'relay.sock') })
  let captured
  const wrapper = { async acquireAgentPty(options) { const acquired = await relay.acquireAgentPty(options); captured = acquired.pty; return acquired } }
  const manager = createShellManager({ transport, relay: wrapper, config })
  t.after(async () => { await manager.dispose(); await relay.dispose(); await rm(directory, { recursive: true, force: true }) })
  const agent = { id: 'agent', session: { id: 'conversation' } }
  const opened = await manager.open({ agent, host })
  return { manager, relay, raw, host, agent, opened, data, exit, get captured() { return captured } }
}

test('shared close rejects an unfinished send without remote exit, signals, or late input', async (t) => {
  const env = await setup(t)
  const handle = env.captured
  const send = env.manager.send({ agent: env.agent, sessionId: env.opened.sessionId, text: 'long-running-command' })
  const done = send.then(value => ({ value }), error => ({ error }))
  const closed = await env.manager.close({ agent: env.agent, sessionId: env.opened.sessionId })
  assert.equal(closed.sharedTerminalPreserved, true)
  assert.equal((await done).error.code, 'SESSION_RELEASED')
  assert.equal(env.raw.closed, false)
  assert.deepEqual(env.raw.signals, [])
  assert.throws(() => handle.write('late command'), { code: 'SESSION_RELEASED' })
  assert.equal(handle.signal('INT'), false)
  handle.resize(10, 10)
  assert.deepEqual(env.raw.writes, ['long-running-command\r'])
  assert.deepEqual(env.raw.resizes, [])
  assert.equal(env.data.size, 1, 'only the relay output owner remains')
})

test('releasing an owned proof disables signal callbacks before cancellation and rejects stale readiness', async (t) => {
  const env = await setup(t)
  const first = env.captured
  let cancelled = 0
  const proof = first.beginVerifiedLease(() => { cancelled++; first.signal('INT') })
  proof.setReady(true)
  first.release(); first.release()
  assert.equal(cancelled, 1)
  assert.deepEqual(env.raw.signals, [])
  assert.equal(proof.valid(), false)
  const next = await env.relay.acquireAgentPty({ hostName: 'fixture', sessionId: 'conversation' })
  const nextProof = next.pty.beginVerifiedLease(() => {})
  assert.equal(nextProof.ready(), false)
  proof.setReady(true)
  assert.equal(nextProof.ready(), false, 'released proof cannot change new owner readiness')
  next.pty.release()
})

test('releasing one adapter cannot cancel another owners active proof', async (t) => {
  const env = await setup(t)
  const first = env.captured
  const second = await env.relay.acquireAgentPty({ hostName: 'fixture', sessionId: 'conversation' })
  let cancelled = 0
  const proof = second.pty.beginVerifiedLease(() => { cancelled++ })
  proof.setReady(true)
  first.release()
  assert.equal(cancelled, 0)
  assert.equal(proof.valid(), true)
  assert.equal(proof.ready(), true)
  second.pty.release()
  assert.equal(cancelled, 1)
})

test('missing safe release capability refuses Agent close instead of destroying the native terminal', async (t) => {
  const env = await setup(t)
  delete env.captured.release
  await assert.rejects(env.manager.close({ agent: env.agent, sessionId: env.opened.sessionId }), { code: 'SHARED_PTY_RELEASE_UNAVAILABLE' })
  assert.equal(env.raw.closed, false)
  assert.equal(env.manager.size, 1)
  await env.manager.adminClose({ sessionId: env.opened.sessionId })
  assert.equal(env.raw.closed, true)
})

test('explicit management close still terminates the shared SSH channel', async (t) => {
  const env = await setup(t)
  await env.manager.adminClose({ sessionId: env.opened.sessionId })
  assert.equal(env.raw.closed, true)
  assert.equal(env.relay.list().length, 0)
})
