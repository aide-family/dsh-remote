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
import { createShellManager } from '../../lib/terminal/manager.js'
import { createPtySession } from '../../lib/terminal/pty-session.js'

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

/**
 * Offline, deterministic node-launcher options: a plain (non-Electron) node
 * path, so the shell line is stable and no probe ever spawns.
 */
const TEST_LAUNCHER = Object.freeze({
  env: {},
  execPath: '/usr/local/bin/node',
  versions: {},
  platform: 'linux',
  existsSync: () => true,
})

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
 * @param {{ config?: Record<string, any>, transport?: any, hosts?: any[], allowed?: boolean, audit?: any, socketPath?: string, launcher?: Record<string, any> }} [options]
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
    hosts: options.hostStore ?? makeHosts({ hosts: options.hosts, allowed: options.allowed }),
    config: makeConfig(options.config),
    audit,
    logger: QUIET_LOGGER,
    socketPath: options.socketPath ?? path.join(dir, 'terminal.sock'),
    launcher: options.launcher ?? TEST_LAUNCHER,
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
    launcher: TEST_LAUNCHER,
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
    launcher: TEST_LAUNCHER,
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
    launcher: TEST_LAUNCHER,
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
  // v0.5.1: a direct node binary + the bridge path, never a PATH-dependent
  // launcher when the Host already knows its node.
  assert.match(
    opened.shell.command,
    /^exec '\/usr\/local\/bin\/node' '.*lib\/terminal\/bridge\.cjs' --host 'alpha' --session 'conv-1' --socket '.*terminal\.sock'$/u,
  )
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
    bytesIn: 0,
    attachCount: 0,
    lastAttachAt: null,
    lastDetachAt: null,
    sharedWithAgent: false,
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
    launcher: TEST_LAUNCHER,
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

test('relay: bridge attach/detach audit events and the v0.5.1 session counters', async (t) => {
  const { relay, audit } = await makeRelay(t)
  await relay.start()
  await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  assert.equal(relay.list()[0].bytesIn, 0)
  assert.equal(relay.list()[0].attachCount, 0)
  assert.equal(relay.list()[0].lastAttachAt, null)
  assert.equal(relay.list()[0].lastDetachAt, null)

  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1 && relay.list()[0].attachCount === 1, {
    label: 'first bridge attached',
  })
  assert.equal(typeof relay.list()[0].lastAttachAt, 'number')
  assert.equal(relay.list()[0].lastDetachAt, null)

  const second = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 2 && relay.list()[0].attachCount === 2, {
    label: 'second bridge attached',
  })

  // bytesIn counts decoded input frames only (never the replay/output).
  bridge.socket.write(`${JSON.stringify({ t: 'i', d: Buffer.from('echo hi\r').toString('base64') })}\n`)
  await waitFor(() => relay.list()[0].bytesIn === Buffer.byteLength('echo hi\r'), { label: 'bytesIn counted' })
  assert.equal(relay.list()[0].bytesOut, 0)

  detachBridge(second)
  await waitFor(() => relay.list()[0].attached === 1 && relay.list()[0].lastDetachAt !== null, {
    label: 'second bridge detached',
  })
  detachBridge(bridge)
  await waitFor(() => relay.list()[0].attached === 0)
  await waitFor(() => audit.entries.filter((entry) => entry.action === 'detach').length === 2, {
    label: 'detach audit events',
  })

  const terminalEvents = audit.entries.filter((entry) => entry.tool === 'terminal')
  assert.deepEqual(
    terminalEvents.map((entry) => entry.action),
    ['open', 'attach', 'attach', 'detach', 'detach'],
  )
  assert.deepEqual(
    terminalEvents.map((entry) => entry.detail),
    [
      'conv-1::alpha (ops@127.0.0.1:2222)',
      'conv-1::alpha (attached 1)',
      'conv-1::alpha (attached 2)',
      'conv-1::alpha (attached 1)',
      'conv-1::alpha (attached 0)',
    ],
  )
  for (const entry of terminalEvents) {
    assert.equal(entry.host, 'alpha')
    assert.equal(entry.risk, 'read')
    assert.equal(entry.outcome, 'ok')
  }
})

test('relay: shell command uses the Electron run-as-node form when the probe succeeds', async (t) => {
  const execPath = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
  const { relay } = await makeRelay(t, {
    launcher: {
      env: {},
      execPath,
      versions: { electron: '30.0.0' },
      platform: 'darwin',
      existsSync: () => false,
      probeElectronRunAsNode: () => true,
    },
  })
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  assert.match(
    opened.shell.command,
    /^exec env ELECTRON_RUN_AS_NODE=1 '\/Applications\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness' '.*lib\/terminal\/bridge\.cjs' --host 'alpha' --session 'conv-1' --socket '.*terminal\.sock'$/u,
  )
})

test('relay: shell command falls back to the launcher when no node can be launched', async (t) => {
  const { relay } = await makeRelay(t, {
    launcher: {
      env: {},
      execPath: '/Applications/App.app/Contents/MacOS/App',
      versions: { electron: '30.0.0' },
      platform: 'darwin',
      existsSync: () => false,
      probeElectronRunAsNode: () => false,
    },
  })
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  assert.match(
    opened.shell.command,
    /^exec '.*bin\/dsh-remote-terminal' --host 'alpha' --session 'conv-1' --socket '.*terminal\.sock'$/u,
  )
  assert.doesNotMatch(opened.shell.command, /bridge\.cjs/u)
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
  assert.deepEqual(calls, ['open', 'attach', 'reconnect'])

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
    launcher: TEST_LAUNCHER,
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

test('relay: dispose while a bridge is attached is quiescent (never deadlocks)', async (t) => {
  const { relay, transport } = await makeRelay(t)
  await relay.start()
  const opened = await relay.open({ hostName: 'alpha', sessionId: 'conv-1' })
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: 'conv-1' })
  await waitFor(() => relay.list()[0].attached === 1)

  // `server.close()` only completes once every accepted socket is gone; dispose
  // must end the bridges first or a teardown with a live terminal would hang.
  const startedAt = Date.now()
  await relay.dispose()
  assert.equal(relay.isDisposed, true)
  assert.ok(Date.now() - startedAt < 2_000, 'dispose must not wait for the attached bridge')
  await waitFor(() => bridge.closed, { label: 'bridge closed by dispose' })
  assert.equal(transport.ptys[0].closeCalls, 1)
  assert.equal(opened.session.state, 'connected', 'the view returned before dispose is a snapshot')
  assert.deepEqual(relay.list(), [])
})

test('relay + Agent shell manager: native terminal and Agent use one persistent PTY', async (t) => {
  const config = {
    ...makeConfig({ userTerminalTtlMs: 25 }),
    terminalIdleSilenceMs: 30,
    terminalTimeoutMs: 500,
    terminalStartupTimeoutMs: 1_000,
    terminalScrollbackLines: 200,
    terminalScrollbackBytes: 20_000,
    terminalMaxReadBytes: 4_096,
    terminalCols: 80,
    terminalRows: 24,
  }
  const { relay, transport } = await makeRelay(t, { config })
  const manager = createShellManager({ transport, relay, config, logger: QUIET_LOGGER })
  t.after(() => manager.dispose())

  const conversationId = 'conversation-shared'
  const agent = { id: 'agent-runtime-id', session: { id: conversationId } }
  const host = makeHost('alpha')
  const [, opened, raced] = await Promise.all([
    relay.open({ hostName: 'alpha', sessionId: conversationId }),
    manager.open({ agent, host }),
    manager.open({ agent, host }),
  ])
  assert.equal(opened.sessionId, raced.sessionId, 'simultaneous opens join one Agent shell')
  assert.equal(opened.sharedTerminal, true)
  assert.equal(transport.opens.length, 1, 'only one remote PTY is allocated')
  const pty = transport.ptys[0]
  assert.deepEqual(pty.resizes, [], 'Agent attachment preserves the native terminal dimensions')

  // The DSH-native terminal uses relay.open for the same conversation+host key.
  const native = await relay.open({ hostName: 'alpha', sessionId: conversationId })
  assert.equal(native.session.sessionKey, `${conversationId}::alpha`)
  assert.equal(native.session.sharedWithAgent, true)
  assert.equal(transport.opens.length, 1, 'opening the native terminal reuses the Agent PTY')

  const send = manager.send({ agent, sessionId: opened.sessionId, text: 'echo from-agent' })
  await waitFor(() => pty.writes.some((write) => write.startsWith('echo from-agent')), { label: 'Agent input on canonical PTY' })
  pty.emit('agent-output\r\n')
  const agentResult = await send
  assert.match(agentResult.viewport, /agent-output/u)
  assert.equal(transport.opens.length, 1)

  // Attach the DSH bridge after Agent output and verify relay replay uses that
  // same channel, not a second SSH shell.
  const bridge = await attachBridge(relay.socketPath, { host: 'alpha', sessionId: conversationId })
  await waitForText(bridge, 'agent-output')
  await waitFor(() => relay.list({ sessionId: conversationId })[0]?.attached === 1)

  bridge.socket.write(`${JSON.stringify({ t: 'i', d: Buffer.from('echo from-human\r').toString('base64') })}\n`)
  await waitFor(() => pty.writes.some((write) => write.startsWith('echo from-human')), { label: 'human input on canonical PTY' })
  pty.emit('human-output\r\n')
  assert.match(manager.read({ agent, sessionId: opened.sessionId }).text, /human-output/u)

  const interrupted = manager.send({ agent, sessionId: opened.sessionId, text: 'sleep 60' })
  await waitFor(() => pty.writes.some((write) => write.startsWith('sleep 60')), { label: 'long-running Agent send' })
  bridge.socket.write(`${JSON.stringify({ t: 'i', d: Buffer.from('\u0003').toString('base64') })}\n`)
  await waitFor(() => pty.writes.includes('\u0003'), { label: 'human Ctrl-C on shared PTY' })
  pty.emit('^C\r\n$ ')
  const interruptedResult = await interrupted
  assert.match(interruptedResult.viewport, /\^C/u)
  assert.equal(transport.opens.length, 1)

  // Detaching the xterm does not idle-close a shell the Agent still owns.
  detachBridge(bridge)
  await waitFor(() => relay.list({ sessionId: conversationId })[0]?.attached === 0)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(relay.list({ sessionId: conversationId }).length, 1)
  assert.equal(pty.closeCalls, 0)

  await manager.close({ agent, sessionId: opened.sessionId })
  assert.equal(pty.closeCalls, 1)
  assert.deepEqual(relay.list({ sessionId: conversationId }), [])
})

test('relay: Agent PTY acquisition buffers output until the owner subscribes', async (t) => {
  const { relay, transport } = await makeRelay(t)
  const acquired = await relay.acquireAgentPty({ hostName: 'alpha', sessionId: 'conversation-handoff' })
  const pty = transport.ptys[0]
  pty.emit('between-acquire-and-subscribe\r\n')
  const session = createPtySession({
    pty: acquired.pty,
    initialOutput: acquired.initialOutput,
    config: { terminalIdleSilenceMs: 30, terminalStartupTimeoutMs: 1_000, terminalScrollbackLines: 100 },
  })
  await session.start()
  assert.match(session.read().text, /between-acquire-and-subscribe/u)
  await session.close('handoff test done')
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
    launcher: TEST_LAUNCHER,
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

// Cluster shortcuts initialize the canonical channel, never a second shell.
test('relay: cluster login runs once, is confirmed, and Agent adoption does not repeat it', async (t) => {
  const shortcut = makeHost('cluster-a', { viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a' })
  const transport = makeTransport()
  const originalOpen = transport.openPty
  transport.openPty = async (...args) => {
    const pty = await originalOpen(...args)
    pty.write = (text) => { pty.writes.push(text); pty.emit('\r\nroot@web1.cluster-a.example.test:~# ') }
    setImmediate(() => pty.emit('[demo.user@entry-demo ~]$ '))
    return pty
  }
  const { relay, audit } = await makeRelay(t, { transport, hosts: [shortcut], config: { policy: 'auto' } })
  const [first, concurrent] = await Promise.all([
    relay.open({ hostName: 'cluster-a', sessionId: 'conv-login' }),
    relay.open({ hostName: 'cluster-a', sessionId: 'conv-login' }),
  ])
  assert.equal(first.session.loginState, 'confirmed')
  assert.equal(first.shell.host.viaHost, 'bastion-demo')
  assert.equal(concurrent.session.sessionKey, first.session.sessionKey)
  await relay.open({ hostName: 'cluster-a', sessionId: 'conv-login' })
  await relay.acquireAgentPty({ hostName: 'cluster-a', sessionId: 'conv-login' })
  assert.equal(transport.opens.length, 1)
  assert.deepEqual(transport.ptys[0].writes, [shortcut.loginCommand + '\r'])
  assert.equal(audit.entries.filter(e => e.tool === 'terminal.login').length, 2)
})

test('relay: blocked automatic login does not open an entry SSH channel', async (t) => {
  const shortcut = makeHost('cluster-a', { viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a' })
  const { relay, transport } = await makeRelay(t, { hosts: [shortcut], config: { policy: 'never' } })
  await assert.rejects(relay.open({ hostName: 'cluster-a', sessionId: 'conv-denied' }), /Connection action 1\/1 \(command\): Denied by the connection action policy/)
  assert.equal(transport.opens.length, 0)
  assert.equal(relay.list().length, 0)
})

test('relay: missing entry prompt times out, closes the channel and never sends sww', async (t) => {
  const shortcut = makeHost('cluster-a', { viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a' })
  const { relay, transport } = await makeRelay(t, { hosts: [shortcut], config: { policy: 'auto', connectTimeoutMs: 15 } })
  await assert.rejects(relay.open({ hostName: 'cluster-a', sessionId: 'conv-failed' }), /entry host shell prompt/)
  assert.deepEqual(transport.ptys[0].writes, [])
  assert.equal(transport.ptys[0].closed, true)
  assert.equal(relay.list().length, 0)
})

test('relay: dispose cancels cluster startup without publishing a connected session', async (t) => {
  const shortcut = makeHost('cluster-a', { viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a' })
  const { relay, transport } = await makeRelay(t, { hosts: [shortcut], config: { policy: 'auto', connectTimeoutMs: 500 } })
  const opening = relay.open({ hostName: 'cluster-a', sessionId: 'conv-cancel' })
  const rejected = assert.rejects(opening, /cancelled|disposed/)
  await waitFor(() => transport.ptys.length === 1 && transport.ptys[0].dataListeners.size > 1)
  await relay.dispose()
  await rejected
  assert.equal(transport.ptys[0].closed, true)
})

function clusterHost() {
  return makeHost('cluster-a', { viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a' })
}

function loginTransport({ failReconnect = false, synchronousPrompt = false } = {}) {
  const transport = makeTransport()
  const openPty = transport.openPty
  transport.openPty = async (...args) => {
    const pty = await openPty(...args)
    pty.write = text => {
      pty.writes.push(text)
      if (!text.startsWith('sww ')) return
      if (failReconnect && transport.opens.length > 1) pty.emitExit()
      else pty.emit('\r\nroot@web1.cluster-a.example.test:~# ')
    }
    if (synchronousPrompt) {
      const subscribe = pty.onData.bind(pty)
      let replayed = false
      pty.onData = callback => {
        const off = subscribe(callback)
        if (!replayed) { replayed = true; callback('[ops@entrance ~]$ ') }
        return off
      }
    } else setImmediate(() => pty.emit('[ops@entrance ~]$ '))
    return pty
  }
  return transport
}

test('relay: synchronous entry prompt replay initializes login without waiting for more data', async t => {
  const { relay, transport } = await makeRelay(t, { hosts: [clusterHost()], transport: loginTransport({ synchronousPrompt: true }), config: { policy: 'auto', connectTimeoutMs: 100 } })
  const opened = await relay.open({ hostName: 'cluster-a', sessionId: 'sync-prompt' })
  assert.equal(opened.session.loginState, 'confirmed')
  assert.deepEqual(transport.ptys[0].writes, [clusterHost().loginCommand + '\r'])
})

test('relay: login exits during reconnect respect the retry cap without duplicate scheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { relay, transport, audit } = await makeRelay(t, { hosts: [clusterHost()], transport: loginTransport({ failReconnect: true }), config: { policy: 'auto', userTerminalReconnectAttempts: 2 } })
  await relay.open({ hostName: 'cluster-a', sessionId: 'retry-login' })
  transport.ptys[0].emitExit()
  t.mock.timers.tick(1000)
  await waitFor(() => audit.entries.filter(e => e.action === 'reconnect').length === 1)
  assert.equal(relay.list()[0].reconnectAttempt, 1)
  t.mock.timers.tick(2000)
  await waitFor(() => relay.list()[0].state === 'error')
  assert.equal(relay.list()[0].reconnectAttempt, 2)
  t.mock.timers.tick(1000000)
  assert.equal(transport.opens.length, 3)
  assert.equal(audit.entries.filter(e => e.action === 'reconnect').length, 2)
})

test('relay: revoked entrance permission prevents every reconnect channel and login', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let allowed = true
  let finds = 0
  const hostStore = { async find() { finds++; return clusterHost() }, isAllowed: () => allowed }
  const { relay, transport, audit } = await makeRelay(t, { hostStore, transport: loginTransport(), config: { policy: 'auto', userTerminalReconnectAttempts: 2 } })
  await relay.open({ hostName: 'cluster-a', sessionId: 'revoked' })
  allowed = false
  transport.ptys[0].emitExit()
  t.mock.timers.tick(1000)
  await waitFor(() => audit.entries.filter(e => e.action === 'reconnect').length === 1)
  t.mock.timers.tick(2000)
  await waitFor(() => relay.list()[0].state === 'error')
  assert.equal(transport.opens.length, 1)
  assert.equal(finds, 4, 'initial lookup, initial connect, then both reconnect policy lookups')
  assert.match(relay.list()[0].lastError, /allowHosts/)
})

test('relay: human Ctrl-C cancels automatic login while arbitrary startup input is not queued', async t => {
  const { relay, transport } = await makeRelay(t, { hosts: [clusterHost()], config: { policy: 'auto', connectTimeoutMs: 1000 } })
  const opening = relay.open({ hostName: 'cluster-a', sessionId: 'human-cancel' })
  const rejected = assert.rejects(opening, /cancelled/)
  await waitFor(() => transport.ptys.length === 1 && transport.ptys[0].dataListeners.size > 1)
  const bridge = await attachBridge(relay.socketPath, { host: 'cluster-a', sessionId: 'human-cancel' })
  await waitFor(() => relay.list()[0]?.attached === 1)
  bridge.socket.write(JSON.stringify({ t: 'i', d: Buffer.from('echo forbidden\r').toString('base64') }) + '\n')
  bridge.socket.write(JSON.stringify({ t: 'i', d: Buffer.from('\u0003').toString('base64') }) + '\n')
  await rejected
  assert.deepEqual(transport.ptys[0].writes, ['\u0003'])
  assert.equal(transport.ptys[0].closed, true)
})

test('relay: cancelling a shared startup reuser does not cancel the creator or send extra login', async t => {
  const { relay, transport } = await makeRelay(t, { hosts: [clusterHost()], config: { policy: 'auto', connectTimeoutMs: 1000 } })
  const creator = relay.open({ hostName: 'cluster-a', sessionId: 'cancel-reuser' })
  await waitFor(() => transport.ptys.length === 1 && transport.ptys[0].dataListeners.size > 1)
  const controller = new AbortController()
  const reuser = relay.open({ hostName: 'cluster-a', sessionId: 'cancel-reuser', signal: controller.signal })
  const rejected = assert.rejects(reuser, /cancelled/)
  controller.abort()
  await rejected
  assert.equal(transport.ptys[0].closed, false)
  transport.ptys[0].write = text => { transport.ptys[0].writes.push(text); transport.ptys[0].emit('\r\nroot@web1.cluster-a.example.test:~# ') }
  transport.ptys[0].emit('[ops@entrance ~]$ ')
  assert.equal((await creator).session.loginState, 'confirmed')
  assert.equal(transport.opens.length, 1)
  assert.equal(transport.ptys[0].writes.length, 1)
})

test('manager: creator cancellation reaches shared login and closes only the new channel', async t => {
  const host = clusterHost()
  const { relay, transport } = await makeRelay(t, { hosts: [host], config: { policy: 'auto', connectTimeoutMs: 1000 } })
  const manager = createShellManager({ transport, relay, config: { terminalStartupTimeoutMs: 1000 } })
  t.after(() => manager.dispose())
  const controller = new AbortController()
  const opening = manager.open({ agent: { session: { id: 'manager-creator' } }, host, signal: controller.signal })
  const rejected = assert.rejects(opening, /cancelled/)
  await waitFor(() => transport.ptys.length === 1 && transport.ptys[0].dataListeners.size > 1)
  controller.abort()
  await rejected
  assert.equal(transport.ptys[0].closed, true)
  assert.deepEqual(transport.ptys[0].writes, [])
  assert.deepEqual(relay.list(), [])
})

test('manager: cancellation during adoption preserves an existing human terminal', async t => {
  const { relay, transport } = await makeRelay(t)
  await relay.open({ hostName: 'alpha', sessionId: 'human-adoption' })
  const manager = createShellManager({ transport, relay, config: { terminalIdleSilenceMs: 500, terminalStartupTimeoutMs: 1000 } })
  t.after(() => manager.dispose())
  const controller = new AbortController()
  const opening = manager.open({ agent: { session: { id: 'human-adoption' } }, host: makeHost('alpha'), signal: controller.signal })
  const rejected = assert.rejects(opening, /cancelled|abort/i)
  await waitFor(() => transport.ptys[0].dataListeners.size > 1)
  controller.abort()
  await rejected
  assert.equal(transport.ptys[0].closed, false)
  assert.equal(relay.list()[0].state, 'connected')
  assert.equal(relay.list()[0].sharedWithAgent, false)
  assert.equal(transport.ptys[0].dataListeners.size, 1)
  assert.equal(transport.opens.length, 1)
})

test('relay: creator cancellation aborts transport startup before any PTY or login', async t => {
  let transportSignal
  const transport = { opens: 0, async openPty(_host, options) {
    this.opens++
    transportSignal = options.signal
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('transport cancelled')), { once: true }))
  } }
  const { relay } = await makeRelay(t, { transport, hosts: [clusterHost()], config: { policy: 'auto' } })
  const controller = new AbortController()
  const opening = relay.open({ hostName: 'cluster-a', sessionId: 'transport-cancel', signal: controller.signal })
  const rejected = assert.rejects(opening, /cancelled/)
  await waitFor(() => transportSignal)
  controller.abort()
  await rejected
  assert.equal(transportSignal.aborted, true)
  assert.deepEqual(relay.list(), [])
})

test('relay: reconnect refreshes changed entrance coordinates rather than retaining stale host', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let current = makeHost('alpha', { host: '192.0.2.1' })
  const hostStore = { async find() { return current }, isAllowed: () => true }
  const { relay, transport } = await makeRelay(t, { hostStore })
  await relay.open({ hostName: 'alpha', sessionId: 'changed-entrance' })
  current = makeHost('alpha', { host: '192.0.2.2', passwordEnv: 'NEW_PASSWORD_ENV' })
  transport.ptys[0].emitExit()
  t.mock.timers.tick(1000)
  await waitFor(() => transport.opens.length === 2 && relay.list()[0].state === 'connected')
  assert.equal(transport.opens[1].host.host, '192.0.2.2')
  assert.equal(transport.opens[1].host.passwordEnv, 'NEW_PASSWORD_ENV')
})

test('relay: human cancellation during reconnect stops retries even if Ctrl-C emits a target prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = loginTransport()
  const openPty = transport.openPty
  transport.openPty = async (...args) => {
    const pty = await openPty(...args)
    if (transport.opens.length > 1) pty.write = text => {
      pty.writes.push(text)
      if (text === '\u0003') pty.emit('\r\nroot@web1.cluster-a.example.test:~# ')
    }
    return pty
  }
  const { relay, audit } = await makeRelay(t, { transport, hosts: [clusterHost()], config: { policy: 'auto', userTerminalReconnectAttempts: 3 } })
  await relay.open({ hostName: 'cluster-a', sessionId: 'cancel-reconnect' })
  const bridge = await attachBridge(relay.socketPath, { host: 'cluster-a', sessionId: 'cancel-reconnect' })
  await waitFor(() => relay.list()[0]?.attached === 1)
  transport.ptys[0].emitExit()
  t.mock.timers.tick(1000)
  await waitFor(() => transport.ptys[1]?.writes.length === 1)
  bridge.socket.write(JSON.stringify({ t: 'i', d: Buffer.from('\u0003').toString('base64') }) + '\n')
  await waitFor(() => relay.list()[0].state === 'error')
  assert.equal(relay.list()[0].loginState, 'failed')
  t.mock.timers.tick(1000000)
  assert.equal(transport.opens.length, 2)
  assert.equal(audit.entries.filter(e => e.tool === 'terminal.login' && e.detail.includes('all connection actions completed')).length, 1)
  detachBridge(bridge)
})

test('manager: cancelling a coalesced waiter preserves the creating Agent operation', async t => {
  const host = clusterHost()
  const { relay, transport } = await makeRelay(t, { hosts: [host], config: { policy: 'auto', connectTimeoutMs: 1000 } })
  const manager = createShellManager({ transport, relay, config: { terminalIdleSilenceMs: 30, terminalStartupTimeoutMs: 1000 } })
  t.after(() => manager.dispose())
  const agent = { session: { id: 'manager-waiter' } }
  const creator = manager.open({ agent, host })
  await waitFor(() => transport.ptys[0]?.dataListeners.size > 1)
  const controller = new AbortController()
  const waiter = manager.open({ agent, host, signal: controller.signal })
  const rejected = assert.rejects(waiter, /cancelled/)
  controller.abort()
  await rejected
  assert.equal(transport.ptys[0].closed, false)
  transport.ptys[0].write = text => { transport.ptys[0].writes.push(text); transport.ptys[0].emit('\r\nroot@web1.cluster-a.example.test:~# ') }
  transport.ptys[0].emit('[ops@entrance ~]$ ')
  assert.equal((await creator).sharedTerminal, true)
  assert.equal(transport.opens.length, 1)
})

test('relay: custom action sequence finishes once in canonical PTY with safe progress', async (t) => {
  const command = 'choose-cluster action-value-not-a-log'
  const actions = [
    { type: 'command', value: command, expect: 'Selection:' },
    { type: 'text', value: '1' },
    { type: 'key', value: 'Enter' },
    { type: 'wait', value: 'Target ready' },
    { type: 'delay', durationMs: 1 },
    { type: 'command', value: 'echo done' },
  ]
  const host = makeHost('target', { viaHost: 'bastion-demo', actions })
  const transport = makeTransport()
  const original = transport.openPty
  transport.openPty = async (...args) => {
    const pty = await original(...args)
    pty.write = text => {
      pty.writes.push(text)
      if (text === command + '\r') pty.emit('\r\nSelection: ')
      else if (text === '\r') pty.emit('\r\nTarget ready\r\n[ops@target ~]$ ')
      else if (text === 'echo done\r') pty.emit('\r\ndone\r\n[ops@target ~]$ ')
    }
    setImmediate(() => pty.emit('[ops@entrance ~]$ '))
    return pty
  }
  const { relay, audit } = await makeRelay(t, { transport, hosts: [host], config: { policy: 'auto' } })
  const first = await relay.open({ hostName: 'target', sessionId: 'conv-actions' })
  assert.equal(first.session.state, 'connected')
  assert.equal(first.session.loginState, 'confirmed')
  assert.equal(first.session.actionProgress.state, 'completed')
  assert.equal(first.session.actionProgress.completed, actions.length)
  assert.equal(first.shell.host.actionCount, actions.length)
  await relay.open({ hostName: 'target', sessionId: 'conv-actions' })
  await relay.acquireAgentPty({ hostName: 'target', sessionId: 'conv-actions' })
  assert.equal(transport.opens.length, 1)
  assert.deepEqual(transport.ptys[0].writes, [command + '\r', '1', '\r', 'echo done\r'])
  assert.equal(JSON.stringify(audit.entries).includes(command), false)
  assert.equal(JSON.stringify(first.session.actionProgress).includes(command), false)
})

test('relay: failed custom action never sends remaining commands or publishes ready', async (t) => {
  const host = makeHost('target', { viaHost: 'bastion-demo', actions: [
    { type: 'wait', value: 'Never arrives', timeoutMs: 100 },
    { type: 'command', value: 'echo should-not-run' },
  ] })
  const transport = makeTransport()
  const original = transport.openPty
  transport.openPty = async (...args) => {
    const pty = await original(...args)
    setImmediate(() => pty.emit('[ops@entrance ~]$ '))
    return pty
  }
  const { relay } = await makeRelay(t, { transport, hosts: [host], config: { policy: 'auto' } })
  await assert.rejects(relay.open({ hostName: 'target', sessionId: 'conv-actions-fail' }), /timed out|Timed out|timeout/i)
  assert.deepEqual(transport.ptys[0].writes, [])
  assert.equal(transport.ptys[0].closed, true)
  assert.deepEqual(relay.list(), [])
})
