/**
 * Integration test for the remote shell manager against the real fixture SSH
 * server and the real SSH transport: open a PTY shell, run a command, read
 * scrollback, owner fencing, agent disposal and manager disposal.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { startSshServer } from '../fixtures/ssh-server.mjs'
import { createSshTransport } from '../../lib/ssh/transport.js'
import { createShellManager } from '../../lib/terminal/manager.js'
import { targetConnectionDigest } from '../../lib/target-binding.js'

const CONNECT_TIMEOUT_MS = 5_000
const IDLE_SILENCE_MS = 400

const QUIET_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** @param {Record<string, unknown>} [overrides] */
function makeConfig(overrides = {}) {
  return {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    execTimeoutMs: 30_000,
    maxOutputBytes: 200_000,
    terminalEnabled: true,
    terminalRows: 30,
    terminalCols: 100,
    terminalIdleSilenceMs: IDLE_SILENCE_MS,
    terminalTimeoutMs: 5_000,
    terminalStartupTimeoutMs: 10_000,
    terminalScrollbackLines: 500,
    terminalScrollbackBytes: 500_000,
    terminalMaxReadBytes: 65_536,
    ...overrides,
  }
}

/** Minimal Cordis-like context: event listeners + effect teardown. */
function makeCtx() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Array<() => any>} */
  const teardowns = []
  return {
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(callback)
      return () => listeners.get(event)?.delete(callback)
    },
    effect(fn) {
      teardowns.push(fn())
    },
    emit(event, payload) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(payload)
    },
    async disposeEffects() {
      for (const teardown of teardowns.splice(0)) await teardown?.()
    },
  }
}

/** @param {any} srv */
function makeHost(srv) {
  return {
    id: 'config:fixture',
    name: 'fixture',
    host: srv.host,
    port: srv.port,
    username: srv.username,
    source: 'config',
    identityFile: srv.privateKeyPath,
  }
}

/** @param {() => boolean|Promise<boolean>} predicate @param {number} [timeoutMs] */
async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - startedAt >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('remote shell manager: real SSH fixture end to end', async (t) => {
  const srv = await startSshServer()
  const transport = createSshTransport({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    idleMs: -1,
    knownHostsPolicy: 'insecure',
    logger: QUIET_LOGGER,
  })
  const ctx = makeCtx()
  const manager = createShellManager({
    ctx,
    transport,
    config: makeConfig(),
    logger: QUIET_LOGGER,
  })
  const agentA = { id: 'agent-a', name: 'A' }
  const agentB = { id: 'agent-b', name: 'B' }
  const host = makeHost(srv)

  try {
    // --- open: startup output is collected into the motd ---------------------
    const opened = await manager.open({ agent: agentA, host })
    assert.match(opened.sessionId, /^remote-shell-\d+$/u)
    assert.equal(opened.host, 'fixture')
    assert.equal(opened.status.kind, 'running')
    assert.equal(typeof opened.motd, 'string')
    assert.match(opened.motd, /fixture-shell-ready/u)

    // --- send: a real command runs and settles as inferred_idle --------------
    const sent = await manager.send({
      agent: agentA,
      sessionId: opened.sessionId,
      text: 'echo pty-live',
    })
    assert.equal(sent.waitReason, 'inferred_idle')
    assert.match(sent.viewport, /pty-live/u)
    assert.equal(sent.sessionStatus.kind, 'running')
    assert.equal(sent.truncated, false)

    // --- read: scrollback contains the command output ------------------------
    const page = manager.read({ agent: agentA, sessionId: opened.sessionId, offset: 0, count: 50 })
    assert.match(page.text, /pty-live/u)
    assert.equal(page.totalLines > 0, true)
    const whole = manager.read({ agent: agentA, sessionId: opened.sessionId })
    assert.match(whole.text, /pty-live/u)

    // --- describe / list -----------------------------------------------------
    const described = manager.describe(agentA, opened.sessionId)
    assert.deepEqual(described, {
      sessionId: opened.sessionId,
      host: 'fixture',
      status: { kind: 'running' },
      connectionDigest: targetConnectionDigest(host),
    })
    const listA = manager.list(agentA)
    assert.equal(listA.length, 1)
    assert.equal(listA[0].sessionId, opened.sessionId)
    assert.equal(listA[0].host, 'fixture')
    assert.equal(listA[0].status.kind, 'running')
    assert.deepEqual(manager.list(agentB), [])

    // --- ownership fencing ---------------------------------------------------
    assert.throws(
      () => manager.describe(agentB, opened.sessionId),
      (error) => error.code === 'FOREIGN_SESSION',
    )
    assert.throws(
      () => manager.read({ agent: agentB, sessionId: opened.sessionId }),
      (error) => error.code === 'FOREIGN_SESSION',
    )
    await assert.rejects(
      manager.send({ agent: agentB, sessionId: opened.sessionId, text: 'echo nope' }),
      (error) => error.code === 'FOREIGN_SESSION',
    )
    await assert.rejects(
      manager.close({ agent: agentB, sessionId: opened.sessionId }),
      (error) => error.code === 'FOREIGN_SESSION',
    )
    assert.throws(
      () => manager.describe(agentA, 'remote-shell-9999'),
      (error) => error.code === 'NO_SESSION',
    )

    // --- close: registry is empty afterwards, second close is NO_SESSION -----
    const closed = await manager.close({
      agent: agentA,
      sessionId: opened.sessionId,
      reason: 'integration test',
    })
    assert.deepEqual(closed, { sessionId: opened.sessionId, closed: true })
    assert.deepEqual(manager.list(agentA), [])
    await assert.rejects(
      manager.close({ agent: agentA, sessionId: opened.sessionId }),
      (error) => error.code === 'NO_SESSION',
    )

    // --- cwd: open in a directory and verify with pwd ------------------------
    const withCwd = await manager.open({ agent: agentA, host, cwd: srv.rootDir })
    const pwd = await manager.send({ agent: agentA, sessionId: withCwd.sessionId, text: 'pwd' })
    assert.match(pwd.viewport, new RegExp(escapeRegExp(srv.rootDir), 'u'))

    // --- agent/disposed closes that agent's sessions -------------------------
    ctx.emit('agent/disposed', agentA)
    assert.equal(await waitFor(() => manager.list(agentA).length === 0), true)

    // --- dispose: quiescent, idempotent, refuses later opens -----------------
    await manager.open({ agent: agentB, host })
    await manager.dispose()
    assert.equal(manager.isDisposed, true)
    assert.deepEqual(manager.list(agentB), [])
    await manager.dispose()
    await assert.rejects(
      manager.open({ agent: agentB, host }),
      (error) => error.code === 'DISPOSED',
    )
    await ctx.disposeEffects()

    // Every fixture shell channel is closed after disposal.
    assert.equal(
      await waitFor(() => srv.shellSessions.length > 0 && srv.shellSessions.every((record) => record.closedAt !== null)),
      true,
    )
  } finally {
    await manager.dispose().catch(() => {})
    transport.dispose()
    await srv.close()
  }
})

// ---------------------------------------------------------------------------
// Manager failure paths with a fake transport (no SSH)
// ---------------------------------------------------------------------------

/** Minimal fake transport PTY handle for manager-level failure tests. */
class FakePty {
  constructor() {
    /** @type {Set<(text: string) => void>} */
    this.dataListeners = new Set()
    /** @type {Set<(info: any) => void>} */
    this.exitListeners = new Set()
    /** @type {string[]} */
    this.writes = []
    /** @type {string[]} */
    this.signals = []
    /** @type {{ kind: string, exitCode?: number|null, signal?: string|null }} */
    this.statusValue = { kind: 'running' }
    this.closeCalls = 0
    /** @type {Error|null} */
    this.closeError = null
  }

  write(data) {
    this.writes.push(data)
  }

  resize() {}

  signal(name) {
    this.signals.push(name)
  }

  onData(callback) {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onExit(callback) {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  status() {
    return this.statusValue
  }

  async close() {
    this.closeCalls += 1
    if (this.closeError) throw this.closeError
  }

  /** @param {string} text */
  emitData(text) {
    for (const callback of [...this.dataListeners]) callback(text)
  }

  /** @param {{ code?: number|null, signal?: string|null }} [info] */
  emitExit(info = {}) {
    this.statusValue = { kind: 'exited', exitCode: info.code ?? null, signal: info.signal ?? null }
    for (const callback of [...this.exitListeners]) callback({ code: info.code ?? null, signal: info.signal ?? null })
  }
}

/**
 * @param {{ exitDuringStartup?: boolean }} [options]
 */
function makeFakeTransport(options = {}) {
  /** @type {FakePty[]} */
  const created = []
  const transport = {
    created,
    async openPty() {
      const pty = new FakePty()
      created.push(pty)
      setTimeout(() => {
        if (options.exitDuringStartup) pty.emitExit({ code: 1 })
        else pty.emitData('$ ')
      }, 10)
      return pty
    },
  }
  return transport
}

test('remote shell manager: fake transport failure paths and fencing', async () => {
  const config = makeConfig({
    terminalIdleSilenceMs: 30,
    terminalTimeoutMs: 120,
    terminalStartupTimeoutMs: 2_000,
  })
  const agent = { id: 'fake-agent' }
  const host = { id: 'config:fake', name: 'fake', host: '127.0.0.1' }

  // A shell that exits during startup rejects the open and closes the channel.
  const failingTransport = makeFakeTransport({ exitDuringStartup: true })
  const failingManager = createShellManager({ transport: failingTransport, config, logger: QUIET_LOGGER })
  await assert.rejects(
    failingManager.open({ agent, host }),
    (error) => error.code === 'SESSION_EXIT',
  )
  assert.equal(failingTransport.created.length, 1)
  assert.equal(failingTransport.created[0].closeCalls, 1)
  assert.equal(failingManager.size, 0)
  assert.deepEqual(failingManager.list(agent), [])
  await failingManager.dispose()

  // SEND_ACTIVE, exited status snapshots and close-failure continuation.
  const transport = makeFakeTransport()
  const manager = createShellManager({ transport, config, logger: QUIET_LOGGER })
  const opened = await manager.open({ agent, host })
  assert.equal(opened.sessionId, 'remote-shell-1')
  assert.equal(opened.host, 'fake')
  assert.equal(opened.status.kind, 'running')
  const pty = transport.created[0]

  const first = manager.send({ agent, sessionId: opened.sessionId, text: 'sleep 60' })
  await assert.rejects(
    manager.send({ agent, sessionId: opened.sessionId, text: 'echo other' }),
    (error) => error.code === 'SEND_ACTIVE',
  )
  const firstResult = await first
  assert.equal(firstResult.waitReason, 'inferred_idle')

  pty.emitExit({ code: 3 })
  const described = manager.describe(agent, opened.sessionId)
  assert.deepEqual(described.status, { kind: 'exited', exitCode: 3, signal: null })

  pty.closeError = new Error('channel already gone')
  const closed = await manager.close({ agent, sessionId: opened.sessionId })
  assert.deepEqual(closed, { sessionId: opened.sessionId, closed: true })
  assert.equal(pty.closeCalls, 1)
  assert.equal(manager.size, 0)
  await manager.dispose()
})

// ---------------------------------------------------------------------------
// Administrative surface (owner-agnostic listing/read/close for the local
// management UI). Agent-facing methods must keep exact-agent fencing.
// ---------------------------------------------------------------------------

test('remote shell manager: admin surface sees every owner without fencing agents', async () => {
  const config = makeConfig({
    terminalIdleSilenceMs: 30,
    terminalTimeoutMs: 120,
    terminalStartupTimeoutMs: 2_000,
  })
  const transport = makeFakeTransport()
  const manager = createShellManager({ transport, config, logger: QUIET_LOGGER })
  const agentA = { id: 'admin-test-a' }
  const agentB = { id: 'admin-test-b' }
  const host = { id: 'config:fake', name: 'fake', host: '127.0.0.1' }

  const openedA = await manager.open({ agent: agentA, host, name: 'from-a' })
  const openedB = await manager.open({ agent: agentB, host })

  // --- adminList: all live sessions, publication order, createdAt, no agent ---
  const listed = manager.adminList()
  assert.deepEqual(
    listed.map((session) => session.sessionId),
    [openedA.sessionId, openedB.sessionId],
  )
  assert.equal(listed[0].host, 'fake')
  assert.equal(listed[0].name, 'from-a')
  assert.equal(listed[1].name, undefined)
  assert.equal(listed[0].status.kind, 'running')
  assert.equal(typeof listed[0].createdAt, 'number')
  assert.equal(listed[0].createdAt <= listed[1].createdAt, true)
  assert.equal('agent' in listed[0], false)
  // Owner-fenced list still only sees its own session.
  assert.deepEqual(
    manager.list(agentA).map((session) => session.sessionId),
    [openedA.sessionId],
  )

  // --- adminGet: snapshot of any session; unknown/invalid ids -> undefined ----
  assert.deepEqual(manager.adminGet(openedB.sessionId), {
    sessionId: openedB.sessionId,
    host: 'fake',
    status: { kind: 'running' },
    ownerSessionId: agentB.id,
  })
  assert.equal(manager.adminGet('remote-shell-9999'), undefined)
  assert.equal(manager.adminGet(undefined), undefined)
  assert.equal(manager.adminGet(42), undefined)

  // --- adminRead: scrollback without owner fencing, same page mapping --------
  transport.created[0].emitData('admin-visible\n$ ')
  const adminPage = manager.adminRead({ sessionId: openedA.sessionId, offset: 0, count: 10 })
  assert.equal(adminPage.sessionId, openedA.sessionId)
  assert.equal(adminPage.host, 'fake')
  assert.match(adminPage.text, /admin-visible/u)
  assert.equal(adminPage.totalLines > 0, true)
  assert.equal(typeof adminPage.lineBegin, 'number')
  assert.equal(typeof adminPage.lineEnd, 'number')
  assert.equal(adminPage.truncated, false)
  const ownerPage = manager.read({ agent: agentA, sessionId: openedA.sessionId, offset: 0, count: 10 })
  assert.equal(adminPage.text, ownerPage.text)
  assert.throws(
    () => manager.adminRead({ sessionId: 'remote-shell-9999' }),
    (error) => error.code === 'NO_SESSION',
  )

  // --- agent-facing operations still use exact-agent fencing ----------------
  await assert.rejects(
    manager.send({ agent: agentB, sessionId: openedA.sessionId, text: 'echo nope' }),
    (error) => error.code === 'FOREIGN_SESSION',
  )
  assert.throws(
    () => manager.describe(agentB, openedA.sessionId),
    (error) => error.code === 'FOREIGN_SESSION',
  )

  // --- adminClose: closes another agent's session; adminList shrinks ---------
  const closed = await manager.adminClose({ sessionId: openedB.sessionId, reason: 'admin cleanup' })
  assert.deepEqual(closed, { sessionId: openedB.sessionId, closed: true })
  assert.equal(transport.created[1].closeCalls, 1)
  assert.deepEqual(
    manager.adminList().map((session) => session.sessionId),
    [openedA.sessionId],
  )

  // --- adminClose is quiescent and idempotent like close --------------------
  assert.deepEqual(await manager.adminClose({ sessionId: openedA.sessionId }), {
    sessionId: openedA.sessionId,
    closed: true,
  })
  assert.deepEqual(manager.adminList(), [])
  await assert.rejects(
    manager.adminClose({ sessionId: openedA.sessionId }),
    (error) => error.code === 'NO_SESSION',
  )
  await manager.dispose()
})

// ---------------------------------------------------------------------------
// Live terminal mirror streaming through the manager
// ---------------------------------------------------------------------------

test('remote shell manager: manager.send forwards onData streaming', async () => {
  const config = makeConfig({
    terminalIdleSilenceMs: 30,
    terminalTimeoutMs: 120,
    terminalStartupTimeoutMs: 2_000,
  })
  const transport = makeFakeTransport()
  const manager = createShellManager({ transport, config, logger: QUIET_LOGGER })
  const agent = { id: 'stream-test-agent' }
  const host = { id: 'config:fake', name: 'fake', host: '127.0.0.1' }
  const opened = await manager.open({ agent, host })

  const events = []
  const sending = manager.send({
    agent,
    sessionId: opened.sessionId,
    text: 'echo stream',
    onData: (event) => events.push(event),
  })
  transport.created[0].emitData('\x1b[31mstreamed\x1b[0m\n$ ')
  const result = await sending
  assert.equal(result.waitReason, 'inferred_idle')
  assert.deepEqual(events, [{ stream: 'stdout', chunk: 'streamed\n$ ' }])

  // No streaming after the send settled.
  transport.created[0].emitData('after settlement\n')
  assert.equal(events.length, 1)
  await manager.close({ agent, sessionId: opened.sessionId })
  await manager.dispose()
})
