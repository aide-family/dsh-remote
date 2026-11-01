/**
 * Unit tests for lib/terminal/pty-session.js, driven by a fake transport
 * `PtySession` handle (emit data/exit on demand). No SSH, no DSH imports.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPtySession, normalizeSignalName } from '../../lib/terminal/pty-session.js'

// ---------------------------------------------------------------------------
// Fake transport PTY handle
// ---------------------------------------------------------------------------

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
    /** @type {Array<[number, number]>} */
    this.resizes = []
    /** @type {'running'|'exited'} */
    this.statusValue = { kind: 'running' }
    this.closed = false
    this.closeCalls = 0
    /** Called synchronously from write() when set (simulates a fast local PTY). */
    this.onWrite = null
  }

  write(data) {
    if (this.closed) throw new Error('fake pty: write after close')
    this.writes.push(data)
    if (this.onWrite) this.onWrite(data)
  }

  resize(cols, rows) {
    if (this.closed) throw new Error('fake pty: resize after close')
    this.resizes.push([cols, rows])
  }

  signal(name) {
    if (this.closed) throw new Error('fake pty: signal after close')
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
    this.closed = true
  }

  /** @param {string} text */
  emitData(text) {
    for (const callback of [...this.dataListeners]) callback(text)
  }

  /** @param {{ code?: number|null, signal?: string|null }} [info] */
  emitExit(info = {}) {
    const payload = { code: info.code ?? null, signal: info.signal ?? null }
    this.statusValue = { kind: 'exited', exitCode: payload.code, signal: payload.signal }
    for (const callback of [...this.exitListeners]) callback(payload)
  }
}

/** @param {Record<string, unknown>} [overrides] */
function makeConfig(overrides = {}) {
  return {
    terminalIdleSilenceMs: 40,
    terminalTimeoutMs: 250,
    terminalStartupTimeoutMs: 1_000,
    terminalScrollbackLines: 200,
    terminalScrollbackBytes: 200_000,
    terminalMaxReadBytes: 4_096,
    terminalCols: 80,
    terminalRows: 24,
    ...overrides,
  }
}

/**
 * Create a session and complete startup with the given banner.
 *
 * @param {Record<string, unknown>} [configOverrides]
 * @param {string} [banner]
 */
async function startedSession(configOverrides = {}, banner = 'welcome\n$ ') {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig(configOverrides) })
  const startPromise = session.start()
  pty.emitData(banner)
  const started = await startPromise
  return { pty, session, started }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

test('startup: collects output until silence and publishes the motd', async () => {
  const { pty, session, started } = await startedSession()
  assert.match(started.motd, /welcome/)
  assert.equal(started.status.kind, 'running')
  assert.equal(session.motd, started.motd)
  assert.equal(session.status().kind, 'running')
  await session.close()
  assert.equal(pty.closed, true)
})

test('startup: settles with an empty motd when the shell stays silent', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const started = await session.start()
  assert.equal(started.motd, '')
  assert.equal(started.status.kind, 'running')
  await session.close()
})

test('startup: chunked output split by a pause is collected', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const startPromise = session.start()
  pty.emitData('line one\n')
  await new Promise((resolve) => setTimeout(resolve, 10))
  pty.emitData('line two\n$ ')
  const started = await startPromise
  assert.equal(started.motd, 'line one\nline two\n$ ')
  await session.close()
})

test('startup: exit during startup rejects the open with SESSION_EXIT', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const startPromise = session.start()
  pty.emitData('booting...\n')
  pty.emitExit({ code: 1 })
  await assert.rejects(startPromise, (error) => {
    assert.equal(error.code, 'SESSION_EXIT')
    assert.match(error.message, /exited during startup/)
    return true
  })
  assert.equal(session.status().kind, 'exited')
  await session.close()
})

test('startup: a shell that already exited rejects without waiting', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  pty.emitExit({ code: 2 })
  await assert.rejects(session.start(), (error) => error.code === 'SESSION_EXIT')
  await session.close()
})

test('startup: deadline publishes the partial motd instead of hanging', async () => {
  const pty = new FakePty()
  const session = createPtySession({
    pty,
    config: makeConfig({ terminalStartupTimeoutMs: 80, terminalIdleSilenceMs: 5_000 }),
  })
  const startPromise = session.start()
  pty.emitData('partial startup text\n')
  const started = await startPromise
  assert.match(started.motd, /partial startup text/)
  assert.equal(started.status.kind, 'running')
  await session.close()
})

test('startup: aborting the open rejects with AbortError', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const controller = new AbortController()
  const startPromise = session.start({ signal: controller.signal })
  controller.abort()
  await assert.rejects(startPromise, (error) => error.name === 'AbortError')
  await session.close()
})

test('startup: motd is bounded by terminalMaxReadBytes', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig({ terminalMaxReadBytes: 32 }) })
  const startPromise = session.start()
  pty.emitData(`${'x'.repeat(500)}\n$ `)
  const started = await startPromise
  assert.equal(Buffer.byteLength(started.motd, 'utf8') <= 32, true)
  await session.close()
})

// ---------------------------------------------------------------------------
// Send lifecycle
// ---------------------------------------------------------------------------

test('send: writes text + Enter and settles as inferred_idle after silence', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'echo hi', submit: true })
  assert.deepEqual(pty.writes, ['echo hi\r'])
  pty.emitData('echo hi\r\nhi\r\n$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  assert.match(result.viewport, /hi/)
  assert.equal(result.sessionStatus.kind, 'running')
  assert.equal(result.truncated, false)
  await session.close()
})

test('send: submit=false writes raw input without Enter', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: '\u0003', submit: false })
  assert.deepEqual(pty.writes, ['\u0003'])
  pty.emitData('^C\n$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  await session.close()
})

test('send: continuous output past terminalTimeoutMs settles as timeout', async () => {
  const { pty, session } = await startedSession()
  const startedAt = Date.now()
  const operation = session.startSend({ text: 'yes', submit: true })
  // Keep the channel busy (shorter than the idle silence) so no silence settles.
  const drip = setInterval(() => pty.emitData('y\n'), 10)
  const result = await operation.done
  clearInterval(drip)
  assert.equal(result.waitReason, 'timeout')
  assert.equal(Date.now() - startedAt >= 200, true)
  await session.close()
})

test('send: channel exit settles as session_exit with the exit status', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'exit', submit: true })
  pty.emitExit({ code: 7 })
  const result = await operation.done
  assert.equal(result.waitReason, 'session_exit')
  assert.deepEqual(result.sessionStatus, { kind: 'exited', exitCode: 7, signal: null })
  assert.equal(session.status().kind, 'exited')
  await session.close()
})

test('send: only one operation may be active per session (SEND_ACTIVE)', async () => {
  const { pty, session } = await startedSession()
  const first = session.startSend({ text: 'echo one', submit: true })
  assert.throws(
    () => session.startSend({ text: 'echo two', submit: true }),
    (error) => {
      assert.equal(error.code, 'SEND_ACTIVE')
      assert.match(error.message, /already has an active send/)
      return true
    },
  )
  assert.equal(pty.writes.length, 1)
  pty.emitData('one\r\n$ ')
  assert.equal((await first.done).waitReason, 'inferred_idle')

  const second = session.startSend({ text: 'echo two', submit: true })
  pty.emitData('two\r\n$ ')
  assert.equal((await second.done).waitReason, 'inferred_idle')
  await session.close()
})

test('send: cancel delivers INT and the operation can still settle', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'sleep 60', submit: true })
  assert.equal(operation.cancel(), true)
  assert.deepEqual(pty.signals, ['INT'])
  pty.emitData('^C\n$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  assert.equal(operation.cancel(), false)
  await session.close()
})

test('send: an aborted signal delivers INT and rejects with AbortError', async () => {
  const { pty, session } = await startedSession()
  const controller = new AbortController()
  const operation = session.startSend({ text: 'sleep 60', submit: true, signal: controller.signal })
  controller.abort()
  await assert.rejects(operation.done, (error) => error.name === 'AbortError')
  assert.deepEqual(pty.signals, ['INT'])
  await session.close()
})

test('send: readOutput consumes deltas and the final viewport only has the rest', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'printf a; printf b', submit: true })
  pty.emitData('first-part\n')
  const delta = operation.readOutput()
  assert.match(delta.delta, /first-part/)
  assert.equal(delta.truncated, false)
  pty.emitData('second-part\n$ ')
  const result = await operation.done
  assert.match(result.viewport, /second-part/)
  assert.equal(result.viewport.includes('first-part'), false)
  await session.close()
})

test('send: viewport is bounded by terminalMaxReadBytes and flagged truncated', async () => {
  const { pty, session } = await startedSession({ terminalMaxReadBytes: 32 })
  const operation = session.startSend({ text: 'yes', submit: true })
  pty.emitData(`${'y'.repeat(300)}\n$ `)
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  assert.equal(Buffer.byteLength(result.viewport, 'utf8') <= 32, true)
  assert.equal(result.truncated, true)
  await session.close()
})

test('send: a synchronous write that emits output is captured', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const startPromise = session.start()
  pty.emitData('$ ')
  await startPromise
  pty.onWrite = (data) => {
    if (data === 'prompt\r') pty.emitData('prompt\r\n$ ')
  }
  const operation = session.startSend({ text: 'prompt', submit: true })
  const result = await operation.done
  assert.match(result.viewport, /prompt/)
  assert.equal(result.waitReason, 'inferred_idle')
  await session.close()
})

test('send: rejected before startup completes or after close', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  pty.emitExit({ code: 0 })
  await assert.rejects(session.start(), (error) => error.code === 'SESSION_EXIT')
  assert.throws(
    () => session.startSend({ text: 'ls', submit: true }),
    (error) => error.code === 'SESSION_EXIT',
  )

  const other = await startedSession()
  await other.session.close()
  assert.throws(
    () => other.session.startSend({ text: 'ls', submit: true }),
    (error) => error.code === 'SESSION_CLOSED',
  )
})

// ---------------------------------------------------------------------------
// read / signal / resize / status / close
// ---------------------------------------------------------------------------

test('read: pages the retained scrollback newest-relative', async () => {
  const { pty, session, started } = await startedSession({}, 'banner\n')
  assert.match(started.motd, /banner/)
  pty.emitData('a\nb\nc\nd\ne\n')
  const newest = session.read({ offset: 0, count: 2 })
  assert.equal(newest.text, 'd\ne')
  assert.equal(newest.lineBegin, 0)
  assert.equal(newest.lineEnd, 2)
  const older = session.read({ offset: 2, count: 2 })
  assert.equal(older.text, 'b\nc')
  assert.equal(older.lineBegin, 2)
  assert.equal(older.lineEnd, 4)
  await session.close()
})

test('read: invalid pagination is rejected', async () => {
  const { session } = await startedSession()
  assert.throws(() => session.read({ offset: -1 }), /offset/)
  assert.throws(() => session.read({ offset: 0, count: 0 }), /count/)
  await session.close()
})

test('signal: maps SIGINT to the ssh2 channel name and reports the result', async () => {
  const { pty, session } = await startedSession()
  const result = await session.signal('SIGINT')
  assert.deepEqual(result, { delivered: true, targetPgid: 0 })
  assert.deepEqual(pty.signals, ['INT'])
  await session.signal('sigterm')
  assert.deepEqual(pty.signals, ['INT', 'TERM'])
  await assert.rejects(session.signal('SIGUSR1'), /signal must be one of/)
  await session.close()
  await assert.rejects(session.signal('SIGINT'), (error) => error.code === 'SESSION_CLOSED')
})

test('signal: normalizeSignalName accepts both POSIX and short names', () => {
  assert.equal(normalizeSignalName('SIGKILL'), 'KILL')
  assert.equal(normalizeSignalName('HUP'), 'HUP')
  assert.throws(() => normalizeSignalName('SIGUSR1'), /signal/)
  assert.throws(() => normalizeSignalName(42), /signal/)
})

test('resize: best-effort window resize is forwarded', async () => {
  const { pty, session } = await startedSession()
  session.resize(100, 30)
  assert.deepEqual(pty.resizes, [[100, 30]])
  await session.close()
})

test('close: idempotent, quiescent, and settles an active send as session_exit', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'tail -f log', submit: true })
  const first = session.close('test close')
  const second = session.close('again')
  assert.equal(first, second)
  await first
  assert.equal(pty.closeCalls, 1)
  assert.equal(pty.closed, true)
  const result = await operation.done
  assert.equal(result.waitReason, 'session_exit')

  const unstartedPty = new FakePty()
  const unstarted = createPtySession({ pty: unstartedPty, config: makeConfig() })
  await unstarted.close()
  await assert.rejects(unstarted.start(), (error) => error.code === 'SESSION_CLOSED')
})

test('close: a failing transport close is surfaced after the session is torn down', async () => {
  const pty = new FakePty()
  const session = createPtySession({ pty, config: makeConfig() })
  const startPromise = session.start()
  pty.emitData('$ ')
  await startPromise
  pty.close = async () => {
    throw new Error('channel already gone')
  }
  await assert.rejects(session.close(), /channel already gone/)
  assert.equal(session.isClosed, true)
})

// ---------------------------------------------------------------------------
// Live terminal mirror streaming (optional onData callback)
// ---------------------------------------------------------------------------

test('onData: streams sanitized send output as {stream:"stdout",chunk}', async () => {
  const { pty, session } = await startedSession()
  const events = []
  const operation = session.startSend({
    text: 'echo hi',
    submit: true,
    onData: (event) => events.push(event),
  })
  pty.emitData('echo hi\r\n\x1b[32mhi\x1b[0m\r\n$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  // ANSI escapes stripped, other terminal control characters preserved verbatim.
  assert.deepEqual(events, [{ stream: 'stdout', chunk: 'echo hi\r\nhi\r\n$ ' }])
  await session.close()
})

test('onData: skips startup/escape-only output and never fires after settlement', async () => {
  const { pty, session, started } = await startedSession()
  assert.match(started.motd, /welcome/)
  const events = []
  const operation = session.startSend({
    text: 'run',
    submit: true,
    onData: (event) => events.push(event),
  })
  pty.emitData('\x1b[0m\x1b[2J')
  assert.deepEqual(events, [])
  pty.emitData('visible\r\n')
  assert.deepEqual(events, [{ stream: 'stdout', chunk: 'visible\r\n' }])
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  const settledCount = events.length
  pty.emitData('after settle\r\n')
  assert.equal(events.length, settledCount)
  // Late output still reaches scrollback (only the live stream stops).
  assert.match(session.read({ offset: 0, count: 5 }).text, /after settle/)
  await session.close()
})

test('onData: a throwing callback never breaks the send or the session', async () => {
  const { pty, session } = await startedSession()
  let calls = 0
  const operation = session.startSend({
    text: 'explode',
    submit: true,
    onData: () => {
      calls += 1
      throw new Error('mirror boom')
    },
  })
  pty.emitData('first\r\n')
  pty.emitData('second\r\n$ ')
  const result = await operation.done
  assert.equal(calls, 2)
  assert.equal(result.waitReason, 'inferred_idle')
  assert.match(result.viewport, /first/)
  assert.match(result.viewport, /second/)

  // The session remains usable for the next send.
  const next = session.startSend({ text: 'again', submit: true })
  assert.equal(pty.writes.at(-1), 'again\r')
  pty.emitData('ok\r\n$ ')
  assert.equal((await next.done).waitReason, 'inferred_idle')
  await session.close()
})

test('onData: streaming does not change readOutput or the settled viewport', async () => {
  const { pty, session } = await startedSession()
  const events = []
  const operation = session.startSend({
    text: 'split',
    submit: true,
    onData: (event) => events.push(event),
  })
  pty.emitData('one\r\n')
  const delta = operation.readOutput()
  pty.emitData('two\r\n$ ')
  const result = await operation.done
  assert.match(delta.delta, /one/)
  assert.match(result.viewport, /two/)
  assert.equal(result.viewport.includes('one'), false)
  assert.equal(events.length, 2)
  await session.close()
})

test('onData: omitting the callback leaves send semantics unchanged', async () => {
  const { pty, session } = await startedSession()
  const operation = session.startSend({ text: 'echo plain', submit: true })
  pty.emitData('echo plain\r\nplain\r\n$ ')
  const result = await operation.done
  assert.equal(result.waitReason, 'inferred_idle')
  assert.equal(result.truncated, false)
  assert.match(result.viewport, /plain/)
  await session.close()
})
