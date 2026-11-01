/**
 * Unit tests for the v0.5 terminal relay (`lib/terminal/relay.js`) using a fake
 * SSH transport and controllable fake `PtySession`s: session reuse, replay,
 * broadcast, input/resize routing, reconnect/backoff, idle TTL, close and
 * quiescent dispose. No real SSH, no real network.
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CLEAR_SCREEN_SEQUENCE,
  RECONNECT_BACKOFF_MS,
  createTerminalRelay,
  defaultRelaySocketPath,
} from '../../lib/terminal/relay.js'

const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

/** Poll a predicate on the real event loop (works with mocked setTimeout). */
async function waitFor(predicate, { timeoutMs = 4_000, label = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Wait until a client buffer contains a substring. */
async function waitForText(client, text, timeoutMs = 4_000) {
  await waitFor(() => client.text.includes(text), { timeoutMs, label: JSON.stringify(text) })
}

/** One controllable transport-level PTY handle. */
class FakePty {
  /** @param {any} host @param {any} options */
  constructor(host, options) {
    this.host = host
    this.term = options?.term
    this.cols = options?.cols
    this.rows = options?.rows
    this.writes = []
    this.resizes = []
    this.signals = []
    this.closeCalls = 0
    this.closed = false
    /** @type {Set<(text: string) => void>} */
    this.dataListeners = new Set()
    /** @type {Set<(info: any) => void>} */
    this.exitListeners = new Set()
  }
  onData(callback) {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }
  onExit(callback) {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
  write(text) {
    this.writes.push(text)
  }
  resize(cols, rows) {
    this.resizes.push([cols, rows])
    this.cols = cols
    this.rows = rows
  }
  signal(name) {
    this.signals.push(name)
  }
  status() {
    return this.closed ? { kind: 'exited', exitCode: 0, signal: null } : { kind: 'running' }
  }
  async close() {
    this.closeCalls += 1
    this.closed = true
  }
  emit(text) {
    if (this.closed) return
    for (const listener of [...this.dataListeners]) listener(text)
  }
  emitExit(info = { code: 1, signal: null }) {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.exitListeners]) listener(info)
  }
}

/** Fake transport that records `openPty` calls and hands out FakePty handles. */
function makeTransport({ failOpenAfter = Number.POSITIVE_INFINITY } = {}) {
  /** @type {FakePty[]} */
  const ptys = []
  /** @type {Array<{ host: any, options: any }>} */
  const opens = []
  return {
    ptys,
    opens,
    async openPty(host, options = {}) {
      opens.push({ host, options })
      if (opens.length > failOpenAfter) throw new Error('fake ssh connect refused')
      const pty = new FakePty(host, options)
      ptys.push(pty)
      return pty
    },
    dispose() {},
  }
}

/** @param {string} name @param {Record<string, any>} [extra] */
function makeHost(name, extra = {}) {
  return {
    id: `config:${name}`,
    name,
    host: '127.0.0.1',
    port: 2222,
    username: 'ops',
    source: 'config',
    ...extra,
  }
}

/** @param {{ hosts?: any[], allowed?: boolean }} [options] */
function makeHosts({ hosts = [makeHost('alpha')], allowed = true } = {}) {
  return {
    async find(query) {
      const host = hosts.find((candidate) => candidate.name === query || candidate.id === query)
      if (host) return host
      const error = new Error(`unknown host ${JSON.stringify(String(query))}`)
      error.code = 'UNKNOWN_HOST'
      throw error
    },
    isAllowed() {
      return allowed
    },
    async list() {
      return hosts
    },
  }
}

/** @param {Record<string, any>} [overrides] */
function makeConfig(overrides = {}) {
  return {
    userTerminalTtlMs: 60_000,
    userTerminalReconnectAttempts: 2,
    userTerminalScrollbackBytes: 4_096,
    ...overrides,
  }
}

/**
 * Create a relay on a throwaway socket path plus its fakes. Registers teardown.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ config?: Record<string, any>, transport?: any, hosts?: any[], allowed?: boolean, audit?: any, socketPath?: string }} [options]
 */
async function makeRelay(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  const transport = options.transport ?? makeTransport()
  const audit = options.audit ?? {
    entries: [],
    record(entry) {
      this.entries.push(entry)
    },
  }
  const relay = createTerminalRelay({
    transport,
    hosts: makeHosts({ hosts: options.hosts, allowed: options.allowed }),
    config: makeConfig(options.config),
    audit,
    logger: QUIET_LOGGER,
    socketPath: options.socketPath ?? path.join(dir, 'terminal.sock'),
  })
  t.after(async () => {
    await relay.dispose()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return { relay, transport, audit, dir }
}

/**
 * Open a real bridge-style socket client and send a handshake line.
 *
 * @param {string} socketPath
 * @param {{ v?: number, host: string, sessionId: string }} handshake
 */
function attachBridge(socketPath, handshake) {
  const socket = net.connect(socketPath)
  const client = { socket, text: '', closed: false }
  socket.setEncoding('utf8')
  socket.on('data', (data) => {
    client.text += data
  })
  socket.on('close', () => {
    client.closed = true
  })
  socket.on('error', () => {})
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, ...handshake })}\n`)
      resolve(client)
    })
    socket.once('error', reject)
  })
}

/** @param {{ socket: net.Socket }} client */
function detachBridge(client) {
  try {
    client.socket.destroy()
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------------- */
/* Tests                                                                     */
/* ------------------------------------------------------------------------- */

test('relay: socket path defaults, overrides and session keys', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  assert.equal(
    defaultRelaySocketPath({ DSH_HOME: '/tmp/dsh-home' }, '/home/user', 'darwin'),
    '/tmp/dsh-home/remote/terminal.sock',
  )
  assert.equal(
    defaultRelaySocketPath({}, '/home/user', 'darwin'),
    path.join('/home/user', '.dsh', 'remote', 'terminal.sock'),
  )
  assert.match(
    defaultRelaySocketPath({ DSH_HOME: '/tmp/dsh-home' }, '/home/user', 'win32'),
    /^\\\\\.\\pipe\\dsh-remote-terminal-[0-9a-f]{40}$/u,
  )
  assert.deepEqual(RECONNECT_BACKOFF_MS, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
  const socketPath = path.join(dir, 'nested', 'terminal.sock')
  const relay = createTerminalRelay({
    transport: makeTransport(),
    hosts: makeHosts(),
    config: makeConfig(),
    logger: QUIET_LOGGER,
    socketPath,
  })
  t.after(() => relay.dispose())
  assert.equal(relay.socketPath, socketPath)
  assert.equal(relay.sessionKeyFor(undefined, 'alpha'), 'default::alpha')
  assert.equal(relay.sessionKeyFor('', 'alpha'), 'default::alpha')
  assert.equal(relay.sessionKeyFor('conv-1', 'alpha'), 'conv-1::alpha')
  assert.equal(relay.list().length, 0)
  assert.equal(relay.isStarted, false)

  // start() creates the socket (and its 0700 parent dir) and is idempotent.
  await relay.start()
  assert.equal(relay.isStarted, true)
  const stats = await fsp.lstat(socketPath)
  assert.equal(stats.isSocket(), true)
  assert.equal((await fsp.stat(path.dirname(socketPath))).mode & 0o777, 0o700)
  await relay.start()
  await relay.dispose()
  await relay.dispose()
  assert.equal(relay.isDisposed, true)
  await assert.rejects(relay.open({ hostName: 'alpha' }), (error) => error.code === 'TERMINAL_ERROR')
})

test('relay: a live socket is reused, never unlinked, and refuses foreign sessions', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const socketPath = path.join(dir, 'terminal.sock')
  const owner = createTerminalRelay({
    transport: makeTransport(),
    hosts: makeHosts(),
    config: makeConfig(),
    logger: QUIET_LOGGER,
    socketPath,
  })
  t.after(() => owner.dispose())
  await owner.start()
  const opened = await owner.open({ hostName: 'alpha', sessionId: 'conv-1' })

  // A second relay on the same socket path must reuse the live listener instead
  // of unlinking it or failing; it cannot own sessions, so open() is refused.
  const second = createTerminalRelay({
    transport: makeTransport(),
    hosts: makeHosts(),
    config: makeConfig(),
    logger: QUIET_LOGGER,
    socketPath,
  })
  t.after(() => second.dispose())
  await second.start()
  assert.equal(second.isStarted, true)
  await assert.rejects(second.open({ hostName: 'alpha' }), (error) => error.code === 'TERMINAL_ERROR')
  await second.dispose()

  // The owner still serves its session and its socket file was preserved.
  assert.deepEqual(owner.list().map((session) => session.sessionKey), [opened.shell.sessionKey])
  assert.equal((await fsp.lstat(socketPath)).isSocket(), true)
})

test('relay: open builds the shell command and a JSON-safe session view', async (t) => {
  const { relay, transport, audit } = await makeRelay(t)
  await relay.start()
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1', cols: 100, rows: 30 })
  assert.equal(opened.shell.sessionKey, 'conv-1::alpha')
  assert.equal(opened.shell.socketPath, relay.socketPath)
  assert.deepEqual(opened.shell.host, { name: 'alpha', target: 'ops@127.0.0.1:2222' })
  assert.match(opened.shell.command, /^exec '/u)
  assert.match(
    opened.shell.command,
    /--host 'alpha' --session 'conv-1' --socket '.*terminal\.sock'$/u,
  )
  assert.match(opened.shell.command, /bin\/dsh-remote-terminal' /u)
  assert.deepEqual(opened.session, {
    sessionKey: 'conv-1::alpha',
    host: 'alpha',
    target: 'ops@127.0.0.1:2222',
    sessionId: 'conv-1',
    state: 'connected',
    attached: 0,
    reconnectAttempt: 0,
    cols: 100,
    rows: 30,
    createdAt: opened.session.createdAt,
    updatedAt: opened.session.updatedAt,
    lastError: null,
    bytesOut: 0,
  })
  assert.equal(typeof opened.session.createdAt, 'number')
  assert.equal(transport.opens.length, 1)
  assert.equal(transport.opens[0].options.term, 'xterm-256color')
  assert.equal(transport.opens[0].options.cols, 100)
  assert.equal(transport.opens[0].options.rows, 30)
  assert.ok(transport.opens[0].options.signal instanceof AbortSignal)
  assert.equal(audit.entries.length, 1)
  assert.deepEqual(
    audit.entries.map((entry) => [entry.tool, entry.host, entry.action, entry.risk, entry.outcome]),
    [['terminal', 'alpha', 'open', 'read', 'ok']],
  )
  assert.deepEqual(relay.list(), [opened.session])
})

test('relay: reuses one SSH PTY per session key and defaults sessionId', async (t) => {
  const { relay, transport } = await makeRelay(t)
  await relay.start()
  const first = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const second = await relay.open({ hostName: 'alpha', sessionId: 'conv-1', cols: 132, rows: 43 })
  assert.equal(transport.opens.length, 1)
  assert.equal(second.shell.sessionKey, first.shell.sessionKey)
  assert.equal(second.session.createdAt, first.session.createdAt)
  assert.equal(second.session.cols, 132)
  assert.equal(second.session.rows, 43)
  assert.deepEqual(transport.ptys[0].resizes.at(-1), [132, 43])
  const defaulted = await relay.open({ hostName: 'alpha' })
  assert.equal(defaulted.shell.sessionKey, 'default::alpha')
  assert.equal(defaulted.session.sessionId, 'default')
  assert.match(defaulted.shell.command, /--session 'default'/u)
  assert.equal(transport.opens.length, 2)
  assert.deepEqual(
    relay.list().map((session) => session.sessionKey),
    ['conv-1::alpha', 'default::alpha'],
  )
  assert.deepEqual(
    relay.list({ sessionId: 'default' }).map((session) => session.sessionKey),
    ['default::alpha'],
  )
})

test('relay: rejects allowHosts-disallowed hosts with HOST_DISALLOWED', async (t) => {
  const { relay, transport } = await makeRelay(t, { allowed: false })
  await assert.rejects(relay.open({ hostName: 'alpha' }), (error) => {
    assert.equal(error.code, 'HOST_DISALLOWED')
    return true
  })
  assert.equal(transport.opens.length, 0)
  assert.deepEqual(relay.list(), [])
  const unknown = await makeRelay(t)
  await assert.rejects(unknown.relay.open({ hostName: 'missing' }), (error) => error.code === 'UNKNOWN_HOST')
  assert.equal(unknown.transport.opens.length, 0)
})

test('relay: failed PTY opens reject cleanly with no unhandled rejection', async (t) => {
  /** @type {unknown[]} */
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  let calls = 0
  const transport = {
    async openPty() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('boom-openPty')
    },
  }
  const relay = createTerminalRelay({
    transport,
    hosts: makeHosts(),
    config: makeConfig(),
    logger: QUIET_LOGGER,
    socketPath: path.join(dir, 'terminal.sock'),
  })
  t.after(async () => {
    await relay.dispose()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  await relay.start()

  // Concurrent opens share the in-flight attempt; both must reject cleanly.
  const results = await Promise.allSettled([
    relay.open({ hostName: 'alpha', sessionId: 'conv-1' }),
    relay.open({ hostName: 'alpha', sessionId: 'conv-1' }),
  ])
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected'],
  )
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason.code, 'TERMINAL_ERROR')
    assert.match(result.reason.message, /boom-openPty/u)
  }
  assert.ok(calls >= 1)
  assert.deepEqual(relay.list(), [])

  // A later open retries instead of joining the dead attempt.
  await assert.rejects(relay.open({ hostName: 'alpha', sessionId: 'conv-1' }), (error) => error.code === 'TERMINAL_ERROR')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(unhandled, [])
})

test('relay: attach replays a bounded tail with a clear screen and broadcasts output', async (t) => {
  const { relay, transport } = await makeRelay(t, { config: { userTerminalScrollbackBytes: 32 } })
  await relay.start()
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const pty = transport.ptys[0]
  pty.emit('ignored-earlier-output\n')
  pty.emit('a'.repeat(100))
  assert.equal(relay.list()[0].bytesOut, Buffer.byteLength('ignored-earlier-output\n' + 'a'.repeat(100)))
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1, { label: 'bridge attached' })
  await waitForText(bridge, 'a'.repeat(32))
  assert.ok(bridge.text.startsWith(CLEAR_SCREEN_SEQUENCE))
  assert.equal(bridge.text.slice(CLEAR_SCREEN_SEQUENCE.length), 'a'.repeat(32))
  pty.emit('live-broadcast\r\n')
  await waitForText(bridge, 'live-broadcast')
  const second = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 2, { label: 'second bridge attached' })
  await waitForText(second, 'live-broadcast')
  assert.ok(second.text.startsWith(CLEAR_SCREEN_SEQUENCE))
  pty.emit('everyone-sees-this\r\n')
  await waitForText(bridge, 'everyone-sees-this')
  await waitForText(second, 'everyone-sees-this')
  detachBridge(bridge)
  await waitFor(() => relay.list()[0].attached === 1, { label: 'first bridge detached' })
  detachBridge(second)
  await waitFor(() => relay.list()[0].attached === 0, { label: 'all bridges detached' })
})

test('relay: routes input/resize frames and ignores malformed frames', async (t) => {
  const { relay, transport } = await makeRelay(t)
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const pty = transport.ptys[0]
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)
  bridge.socket.write(`${JSON.stringify({ t: 'i', d: Buffer.from('echo hi\r').toString('base64') })}\n`)
  await waitFor(() => pty.writes.includes('echo hi\r'), { label: 'input routed to PTY' })
  bridge.socket.write(`${JSON.stringify({ t: 'r', c: 101, r: 31 })}\n`)
  await waitFor(() => pty.resizes.some(([cols, rows]) => cols === 101 && rows === 31), {
    label: 'resize routed to PTY',
  })
  await waitFor(() => relay.list()[0].cols === 101 && relay.list()[0].rows === 31)
  bridge.socket.write('not json at all\n')
  bridge.socket.write('{"t":"unknown"}\n')
  bridge.socket.write('\n')
  await waitFor(() => relay.list()[0].attached === 1, { label: 'still attached' })

  bridge.socket.write('{"t":"c"}\n')
  await waitFor(() => bridge.closed, { label: 'bridge closed by close frame' })
  await waitFor(() => relay.list()[0].attached === 0)

  // A handshake for an unknown session is rejected (socket closed, PTY untouched).
  const ghost = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'nope' })
  await waitForText(ghost, '终端会话不存在')
  await waitFor(() => ghost.closed, { label: 'unknown session socket closed' })
  assert.equal(transport.opens.length, 1)
})

test('relay: unexpected PTY exit reconnects with backoff and keeps the bridge attached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { relay, transport, audit } = await makeRelay(t, { config: { userTerminalReconnectAttempts: 3 } })
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  const firstPty = transport.ptys[0]
  firstPty.emitExit({ code: 255, signal: null })
  await waitFor(() => relay.list()[0].state === 'reconnecting', { label: 'reconnecting state' })
  await waitForText(bridge, 'SSH 连接已断开')
  assert.equal(relay.list()[0].attached, 1, 'bridge stays attached while reconnecting')

  // First backoff step is 1s; the fake transport immediately succeeds.
  t.mock.timers.tick(1_000)
  await waitFor(() => transport.opens.length === 2, { label: 'reconnect attempt opened a PTY' })
  await waitFor(() => relay.list()[0].state === 'connected', { label: 'connected after reconnect' })
  await waitForText(bridge, 'SSH 连接已恢复')
  assert.equal(relay.list()[0].reconnectAttempt, 0)
  assert.equal(relay.list()[0].attached, 1)

  const calls = audit.entries.map((entry) => entry.action)
  assert.deepEqual(calls, ['open', 'reconnect'])

  // PTY output after the reconnect flows to the still-attached bridge.
  transport.ptys[1].emit('after-reconnect\r\n')
  await waitForText(bridge, 'after-reconnect')

  detachBridge(bridge)
  await waitFor(() => relay.list()[0].attached === 0)
})

test('relay: exhausted reconnect attempts end in error with a final banner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = makeTransport({ failOpenAfter: 1 })
  const { relay, transport: sameTransport, audit } = await makeRelay(t, {
    transport,
    config: { userTerminalReconnectAttempts: 2 },
  })
  assert.equal(transport, sameTransport)
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  transport.ptys[0].emitExit({ code: 1, signal: null })
  await waitFor(() => relay.list()[0].state === 'reconnecting')

  t.mock.timers.tick(1_000) // attempt 1 fails -> next delay 2s
  await waitFor(() => transport.opens.length === 2)
  t.mock.timers.tick(2_000) // attempt 2 fails -> attempts exhausted
  await waitFor(() => relay.list()[0].state === 'error', { label: 'error after retries' })
  await waitForText(bridge, '重连尝试已用尽')
  assert.ok(relay.list()[0].lastError)
  assert.deepEqual(
    audit.entries.filter((entry) => entry.action === 'reconnect').map((entry) => entry.outcome),
    ['error', 'error'],
  )

  detachBridge(bridge)
  await waitFor(() => relay.list()[0].attached === 0)
})

test('relay: idle TTL closes the PTY after the last bridge detaches (0 disables)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { relay, transport, audit } = await makeRelay(t, { config: { userTerminalTtlMs: 5_000 } })
  await relay.start()
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  detachBridge(bridge)
  await waitFor(() => relay.list()[0].attached === 0, { label: 'bridge detached' })

  t.mock.timers.tick(4_999)
  await waitFor(() => relay.list().length === 1, { label: 'session alive before TTL' })
  t.mock.timers.tick(1)
  await waitFor(() => relay.list().length === 0, { label: 'session closed by TTL' })
  assert.equal(transport.ptys[0].closeCalls, 1)
  assert.equal(
    audit.entries.some((entry) => entry.action === 'close' && /ttl/u.test(entry.detail)),
    true,
  )
  assert.equal(await relay.close(opened.shell.sessionKey), false)

  // A zero TTL keeps the session alive indefinitely after detach.
  const disabled = await makeRelay2(t)
  const bridge2 = await attachBridge(disabled.relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => disabled.relay.list()[0]?.attached === 1)
  detachBridge(bridge2)
  await waitFor(() => disabled.relay.list()[0].attached === 0)
  t.mock.timers.tick(10_000_000)
  await waitFor(() => disabled.relay.list().length === 1)
})

// The TTL test needs a second relay whose config uses the same mocked timers.
/** @param {import('node:test').TestContext} t */
async function makeRelay2(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  const relay = createTerminalRelay({
    transport: makeTransport(),
    hosts: makeHosts(),
    config: makeConfig({ userTerminalTtlMs: 0 }),
    logger: QUIET_LOGGER,
    socketPath: path.join(dir, 'terminal.sock'),
  })
  t.after(async () => {
    await relay.dispose()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  return { relay, dir }
}

test('relay: close() closes the PTY only; dispose is quiescent and cleanup-safe', async (t) => {
  const { relay, transport, audit } = await makeRelay(t)
  await relay.start()
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  assert.equal(await relay.close(opened.shell.sessionKey), true)
  assert.equal(await relay.close('does-not-exist'), false)
  assert.deepEqual(relay.list(), [])
  assert.equal(transport.ptys[0].closeCalls, 1)
  await waitFor(() => bridge.closed, { label: 'bridge detached by close()' })
  assert.equal(
    audit.entries.some((entry) => entry.action === 'close' && entry.outcome === 'ok'),
    true,
  )

  const second = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const pty = transport.ptys[1]

  // A socket that connected but never handshook must still be torn down by
  // dispose (it must not leak a handle/timer that keeps the host process alive).
  const raw = net.connect(relay.socketPath)
  raw.on('error', () => {})
  await new Promise((resolve) => raw.once('connect', resolve))

  await relay.dispose()
  assert.equal(relay.isDisposed, true)
  await relay.dispose()
  assert.equal(pty.closeCalls, 1)
  assert.deepEqual(relay.list(), [])
  await assert.rejects(relay.open({ hostName: 'alpha' }), (error) => error.code === 'TERMINAL_ERROR')
  assert.equal(second.session.state, 'connected')
  await waitFor(() => raw.destroyed || raw.readableEnded, { label: 'un-handshaken bridge closed by dispose' })
  raw.destroy()
})

test('relay: a throwing audit/logger never breaks a session or its handlers', async (t) => {
  const explosive = {
    record() {
      throw new Error('audit boom')
    },
  }
  const explosiveLogger = {
    debug() {
      throw new Error('debug boom')
    },
    info() {
      throw new Error('info boom')
    },
    warn() {
      throw new Error('warn boom')
    },
    error() {
      throw new Error('error boom')
    },
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
  const transport = makeTransport()
  const relay = createTerminalRelay({
    transport,
    hosts: makeHosts(),
    config: makeConfig(),
    audit: explosive,
    logger: explosiveLogger,
    socketPath: path.join(dir, 'terminal.sock'),
  })
  t.after(async () => {
    await relay.dispose()
    await fsp.rm(dir, { recursive: true, force: true })
  })
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  transport.ptys[0].emit('still-alive\r\n')
  await waitForText(bridge, 'still-alive')
  bridge.socket.write('{"t":"i","d":"eA=="}\n')
  await waitFor(() => transport.ptys[0].writes.includes('x'))
  bridge.socket.write('{"t":"c"}\n')
  await waitFor(() => bridge.closed)

  assert.equal(await relay.close('missing'), false)
  const sessionKey = relay.list()[0].sessionKey
  assert.equal(await relay.close(sessionKey), true)
  assert.equal(await relay.close(sessionKey), false)
  assert.deepEqual(relay.list(), [])
})
