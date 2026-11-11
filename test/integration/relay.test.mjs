/**
 * Integration test for the v0.5 interactive terminal path: the real relay
 * (`lib/terminal/relay.js`), the real bridge child process
 * (`lib/terminal/bridge.cjs`, spawned with `process.execPath`) and the real
 * fixture SSH server with shell channels.
 *
 * Covers: JSON-line handshake, `fixture-shell-ready` startup output, typed
 * command output, two simultaneous bridge clients sharing one SSH PTY,
 * session reuse after re-open, and an unexpected remote shell exit triggering
 * the reconnect banner plus a fresh shell.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { startSshServer } from '../fixtures/ssh-server.mjs'
import { createSshTransport } from '../../lib/ssh/transport.js'
import { createTerminalRelay } from '../../lib/terminal/relay.js'
import { createShellManager } from '../../lib/terminal/manager.js'
import { createBridgeServer } from '../../lib/terminal/relay-socket.js'

const BRIDGE_PATH = fileURLToPath(new URL('../../lib/terminal/bridge.cjs', import.meta.url))

const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

/** Poll a predicate on the real event loop. */
async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** @param {string} socketPath @param {string} hostName @param {string} sessionId */
function startBridge({ socketPath, hostName, sessionId }) {
  const child = spawn(
    process.execPath,
    [BRIDGE_PATH, '--host', hostName, '--session', sessionId, '--socket', socketPath],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const bridge = { child, stdout: '', stderr: '', closed: false, exitCode: /** @type {number|null} */ (null) }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    bridge.stdout += data
  })
  child.stderr.on('data', (data) => {
    bridge.stderr += data
  })
  bridge.exited = new Promise((resolve) => {
    child.once('exit', (code) => {
      bridge.closed = true
      bridge.exitCode = code
      resolve(undefined)
    })
  })
  /** @param {string} text */
  bridge.write = (text) => child.stdin.write(text)
  return bridge
}

/** @param {{ stdout: string }} bridge @param {string} text @param {number} [timeoutMs] */
async function waitForStdout(bridge, text, timeoutMs = 10_000) {
  await waitFor(() => bridge.stdout.includes(text), { timeoutMs, label: JSON.stringify(text) })
}

/** @param {Record<string, any>} [overrides] */
function makeConfig(overrides = {}) {
  return {
    connectTimeoutMs: 5_000,
    execTimeoutMs: 30_000,
    maxOutputBytes: 200_000,
    terminalRows: 30,
    terminalCols: 100,
    userTerminalTtlMs: 5_000,
    userTerminalReconnectAttempts: 2,
    userTerminalScrollbackBytes: 400_000,
    ...overrides,
  }
}

test('real bridge stops after an explicitly removed session instead of retrying 120 times', { timeout: 7000 }, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-gone-'));
  const socketPath = path.join(directory, 'relay.sock');
  const entry = {};
  let current = entry, lookups = 0;
  const server = createBridgeServer({ socketPath, findSession() { lookups++; return current; }, replayFor() { return 'accepted-fixture-shell\r\n'; } });
  await server.start();
  const bridge = startBridge({ socketPath, hostName: 'fixture', sessionId: 'conversation' });
  t.after(async () => {
    if (!bridge.closed) bridge.child.kill('SIGKILL');
    await bridge.exited;
    await server.dispose();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  await waitForStdout(bridge, 'accepted-fixture-shell');
  current = null;
  server.endEntry(entry);
  await waitFor(() => bridge.closed, { timeoutMs: 5000, label: 'bridge stops after SESSION_GONE' });
  assert.equal(bridge.exitCode, 1);
  assert.equal(lookups, 2, 'one reconnect discovers definitive closure; no retry storm');
  assert.match(bridge.stdout, /已停止重连/);
  assert.equal(bridge.stderr, '');
});

test('terminal relay + real bridge + fixture SSH server', async (t) => {
  const srv = await startSshServer()
  const transport = createSshTransport({
    connectTimeoutMs: 5_000,
    idleMs: -1,
    knownHostsPolicy: 'insecure',
    logger: QUIET_LOGGER,
  })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-int-'))
  const socketPath = path.join(dir, 'terminal.sock')
  const host = {
    id: 'config:termbox',
    name: 'termbox',
    host: srv.host,
    port: srv.port,
    username: srv.username,
    source: 'config',
    identityFile: srv.privateKeyPath,
  }
  const hosts = {
    async find(query) {
      if (query === 'termbox') return host
      const error = new Error(`unknown host ${JSON.stringify(String(query))}`)
      error.code = 'UNKNOWN_HOST'
      throw error
    },
    isAllowed() {
      return true
    },
    async list() {
      return [host]
    },
  }
  const audit = {
    entries: [],
    record(entry) {
      this.entries.push(entry)
    },
  }
  const relay = createTerminalRelay({
    transport,
    hosts,
    config: makeConfig(),
    audit,
    logger: QUIET_LOGGER,
    socketPath,
  })
  /** @type {any} */
  let shellManager
  /** @type {Array<ReturnType<typeof startBridge>>} */
  const bridges = []
  t.after(async () => {
    for (const bridge of bridges) {
      try {
        bridge.child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    await Promise.allSettled(bridges.map((bridge) => bridge.exited))
    await shellManager?.dispose()
    await relay.dispose()
    transport.dispose()
    await srv.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  // --- open: one real SSH PTY through the relay ----------------------------
  await relay.start()
  const opened = await relay.open({ hostName: 'termbox', sessionId: 'int' })
  assert.equal(opened.shell.sessionKey, 'int::termbox')
  // v0.5.1: direct node binary + the bridge path (no PATH-dependent launcher).
  assert.match(
    opened.shell.command,
    /^exec '.*node' '.*lib\/terminal\/bridge\.cjs' --host 'termbox' --session 'int' --socket '.*terminal\.sock'$/u,
  )
  assert.equal(opened.session.attachCount, 0)
  assert.equal(opened.session.bytesIn, 0)
  assert.equal(opened.session.state, 'connected')
  assert.equal(opened.session.target, `testuser@${srv.host}:${srv.port}`)
  await waitFor(() => srv.shellTotal === 1, { label: 'fixture shell channel' })

  // --- bridge 1: handshake + replayed fixture startup output --------------
  const bridgeOne = startBridge({ socketPath, hostName: 'termbox', sessionId: 'int' })
  bridges.push(bridgeOne)
  await waitForStdout(bridgeOne, 'fixture-shell-ready')
  assert.equal(bridgeOne.stderr, '')
  assert.equal(relay.list()[0].attached, 1)
  assert.equal(relay.list()[0].attachCount, 1)
  assert.equal(relay.list()[0].state, 'connected')

  // v0.5.1 diagnostics: the bridge logs to terminal-bridge.log next to the
  // socket, so "never ran" (no file) is distinguishable from "could not
  // attach" (error lines).
  const bridgeLogPath = path.join(dir, 'terminal-bridge.log')
  const readBridgeLog = async () => {
    try {
      return await fsp.readFile(bridgeLogPath, 'utf8')
    } catch {
      return ''
    }
  }
  await waitFor(async () => (await readBridgeLog()).includes('connected'), { label: 'bridge log connected' })
  const bridgeLog = await readBridgeLog()
  assert.match(bridgeLog, /\[dsh-remote-bridge\] start host="termbox" session="int" socket=.*terminal\.sock" node=v\d+\./u)
  assert.match(bridgeLog, /\[dsh-remote-bridge\] connected socket=.*terminal\.sock"/u)

  // --- typed command output flows through the bridge ----------------------
  bridgeOne.write("printf 'relay-ok\\n'\r")
  await waitForStdout(bridgeOne, 'relay-ok')

  // --- bridge 2: simultaneous client shares the same SSH PTY --------------
  const bridgeTwo = startBridge({ socketPath, hostName: 'termbox', sessionId: 'int' })
  bridges.push(bridgeTwo)
  await waitForStdout(bridgeTwo, 'fixture-shell-ready')
  assert.equal(srv.shellTotal, 1, 'a second bridge must not open a second SSH shell')
  bridgeTwo.write("printf 'second-ok\\n'\r")
  await waitForStdout(bridgeOne, 'second-ok')
  await waitForStdout(bridgeTwo, 'second-ok')
  await waitFor(() => relay.list()[0].attached === 2, { label: 'two attached bridges' })
  assert.equal(relay.list()[0].attachCount, 2)
  // Input frames from both bridges are counted (never the PTY output).
  assert.ok(relay.list()[0].bytesIn > 0)
  assert.ok(relay.list()[0].bytesIn < relay.list()[0].bytesOut)

  // --- re-open reuses the live session (native terminal tab close/reopen) --
  const reopened = await relay.open({ hostName: 'termbox', sessionId: 'int' })
  assert.equal(reopened.shell.sessionKey, opened.shell.sessionKey)
  assert.equal(reopened.session.createdAt, opened.session.createdAt)
  assert.equal(reopened.session.attached, 2)
  assert.equal(reopened.session.attachCount, 2)
  assert.equal(typeof reopened.session.lastAttachAt, 'number')
  assert.equal(srv.shellTotal, 1, 're-open must reuse the live SSH PTY')
  assert.deepEqual(
    audit.entries.map((entry) => entry.action),
    ['open', 'attach', 'attach'],
  )
  assert.deepEqual(
    audit.entries.filter((entry) => entry.action === 'attach').map((entry) => entry.detail),
    ['int::termbox (attached 1)', 'int::termbox (attached 2)'],
  )

  // --- fixture shell exit: banner, backoff reconnect, fresh shell ---------
  bridgeOne.write('exit\r')
  await waitForStdout(bridgeOne, 'SSH 连接已断开', 15_000)
  await waitForStdout(bridgeTwo, 'SSH 连接已断开', 15_000)
  await waitForStdout(bridgeOne, 'SSH 连接已恢复', 20_000)
  await waitFor(() => srv.shellTotal >= 2, { label: 'fresh SSH shell after reconnect' })
  const restoredAt = bridgeOne.stdout.indexOf('SSH 连接已恢复')
  await waitFor(() => bridgeOne.stdout.slice(restoredAt).includes('fixture-shell-ready'), {
    timeoutMs: 10_000,
    label: 'fresh shell startup output',
  })
  assert.equal(relay.list()[0].state, 'connected')
  assert.equal(relay.list()[0].attached, 2, 'both bridges stay attached through the reconnect')
  assert.equal(audit.entries.filter((entry) => entry.action === 'reconnect' && entry.outcome === 'ok').length, 1)

  bridgeOne.write("printf 'after-reconnect\\n'\r")
  await waitForStdout(bridgeOne, 'after-reconnect')
  await waitForStdout(bridgeTwo, 'after-reconnect')

  // --- Agent tools borrow the exact PTY already shown in the native terminal ---
  const shellConfig = makeConfig({
    terminalIdleSilenceMs: 100,
    terminalTimeoutMs: 5_000,
    terminalStartupTimeoutMs: 2_000,
    terminalScrollbackLines: 100,
    terminalScrollbackBytes: 20_000,
    terminalMaxReadBytes: 4_096,
  })
  let disposeAgent
  const ctx = { on(_event, callback) { disposeAgent = callback; return () => {} } }
  shellManager = createShellManager({ ctx, transport, relay, config: shellConfig, logger: QUIET_LOGGER })
  let agent = { id: 'agent-runtime-id', session: { id: 'int' } }
  let shell = await shellManager.open({ agent, host })
  assert.equal(shell.sharedTerminal, true)
  assert.equal(srv.shellTotal, 2, 'Agent open must not allocate another SSH shell channel')
  assert.equal(relay.list()[0].sharedWithAgent, true)

  const agentSend = shellManager.send({ agent, sessionId: shell.sessionId, text: "printf 'agent-shared-ok\\n'" })
  await waitForStdout(bridgeOne, 'agent-shared-ok')
  const agentResult = await agentSend
  assert.match(agentResult.viewport, /agent-shared-ok/u)

  bridgeOne.write("printf 'human-shared-ok\\n'\r")
  await waitForStdout(bridgeTwo, 'human-shared-ok')
  await waitFor(() => shellManager.read({ agent, sessionId: shell.sessionId }).text.includes('human-shared-ok'), {
    label: 'human command in Agent scrollback',
  })

  // The bridge's raw Ctrl-C byte is tested against the same acquired PTY in the
  // fake-transport relay/manager test; this real fixture focuses on cross-layer
  // shell/output identity without its pipe-backed line-discipline race.
  assert.equal(srv.shellTotal, 2, 'human and Agent input continue in one SSH shell')

  // Routine task cleanup must leave BOTH native bridges on the same real SSH PTY.
  const released = await shellManager.close({ agent, sessionId: shell.sessionId })
  assert.equal(released.sharedTerminalPreserved, true)
  bridgeOne.write("printf 'human-after-agent-close\\n'\r")
  await waitForStdout(bridgeTwo, 'human-after-agent-close')
  assert.equal(srv.shellTotal, 2, 'Agent close must not force SSH re-login')
  shell = await shellManager.open({ agent, host })
  const continued = await shellManager.send({ agent, sessionId: shell.sessionId, text: "printf 'agent-next-task\\n'" })
  assert.match(continued.viewport, /agent-next-task/)
  disposeAgent({ agent })
  await waitFor(() => shellManager.size === 0, { label: 'Agent disposed handle released' })
  bridgeOne.write("printf 'human-after-agent-dispose\\n'\r")
  await waitForStdout(bridgeTwo, 'human-after-agent-dispose')
  assert.equal(srv.shellTotal, 2)
  agent = { id: 'agent-next-runtime', session: { id: 'int' } }
  shell = await shellManager.open({ agent, host })
  assert.equal(srv.shellTotal, 2, 'new Agent runtime adopts the original native SSH PTY')

  // Once an Agent owns the PTY, exit is reported rather than silently replaced.
  bridgeOne.write('exit\r')
  await waitFor(() => relay.list()[0]?.state === 'error', { label: 'shared PTY exit state' })
  await waitFor(() => shellManager.describe(agent, shell.sessionId).status.kind === 'exited', { label: 'Agent sees shared PTY exit' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(srv.shellTotal, 2, 'Agent-owned PTY exit must not auto-open a fresh shell')

  // --- clean bridge shutdown on SIGTERM ------------------------------------
  for (const bridge of bridges) bridge.child.kill('SIGTERM')
  await Promise.all(bridges.map((bridge) => bridge.exited))
  for (const bridge of bridges) {
    assert.equal(bridge.exitCode, 0)
    assert.equal(bridge.stderr, '')
  }
  await waitFor(() => relay.list()[0].attached === 0, { label: 'all bridges detached' })
  await waitFor(async () => (await readBridgeLog()).includes('exit code=0'), { label: 'bridge log exit' })
  await shellManager.close({ agent, sessionId: shell.sessionId })
  await relay.close(opened.shell.sessionKey)
  assert.deepEqual(relay.list(), [], 'explicit user relay close cleans the ended shared connection')
})
