import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const sessionId = 'conversation-new'
const key = sessionId + '::bastion-demo'
const command = 'exec fixture-bridge --host bastion-demo'

// Contracts verified against shipped 0.2.1-rc.5 Sidebar + Terminal Controller:
// global inventory [{sessionId,tabId,kind,contentId}], session-local tab ids,
// public openTab returns void, occurrence navigation, shared five-arg view.
function setup(options = {}) {
  let registration
  let clock = 100_000
  let openedAt
  let openedParams
  let mounted = sessionId
  let opens = 0
  let oldOpens = 0
  const writes = []
  const views = []
  const traces = []
  const signal = { aborted: false }
  const before = Array.from({ length: 9 }, (_, index) => ({
    sessionId: 'other-conversation', tabId: 'tab' + (index + 1), kind: 'terminal', contentId: 'old-' + index,
  }))
  before.push({ sessionId, tabId: 'tab1', kind: 'dsh-remote-live', contentId: 'remote-live' })
  const targetTab = { sessionId, tabId: 'tab2', kind: 'terminal', contentId: 'new-terminal-address' }
  function published() { return openedAt !== undefined && !options.noPublish && clock - openedAt >= (options.publishDelay || 0) }
  function navigation() { return { address: targetTab.contentId, revision: 1, params: openedParams } }
  const right = {
    mounted: { getSnapshot: () => mounted },
    openTabs: { getSnapshot: () => published() ? [...before,
      // A simultaneous unrelated native terminal must not capture the bridge.
      { ...targetTab, tabId: 'tab3', contentId: 'manual-terminal' },
      { ...targetTab, sessionId: options.foreignOnly ? 'foreign-conversation' : sessionId },
    ] : before },
    tabsIn: () => [],
    active: () => undefined,
    openTab(kind, opts) {
      opens++
      assert.equal(kind, 'terminal')
      openedAt = clock
      openedParams = opts.params
      if (options.openError) throw new Error('surface not adopted')
    },
    openTabIn() { oldOpens++; throw new Error('must not use silent openTabIn') },
    tabDomain: { occurrence(sid, tab) {
      assert.equal(sid, sessionId)
      return { signal, navigation: { getSnapshot: () => tab.id === 'tab2' ? navigation() : { address: 'manual-terminal', params: {} } } }
    } },
  }
  const view = {
    state: { getSnapshot() {
      if (options.closed) signal.aborted = true
      if (options.switchSession) mounted = 'different-conversation'
      return options.failed ? { phase: 'failed', writable: false } : { phase: 'connected', info: { state: 'running' }, writable: true }
    } },
    write(value) { writes.push(value) },
    mount() { assert.fail('native body exclusively owns mount') },
    dispose() { assert.fail('borrowed native view must not be disposed') },
  }
  const terminals = { view(...args) { views.push(args); return view } }
  const bundle = source.replace('    return plugin;', `    return {
      openNativeTerminal,
      configure: function (right, terminals) {
        runtimeRight = right; runtimeTerminals = terminals;
        runtimeCtx = { get: function () { return undefined; } };
      }
    };`)
  assert.notEqual(source, bundle)
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    Date: { now: () => clock },
    setTimeout(fn, delay) { clock += delay; queueMicrotask(fn); return 1 },
    clearTimeout() {},
    AbortController,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      if (body.method === 'terminal.trace') traces.push(body)
      const attached = writes.length > 0 && !options.noAttach
      return { ok: true, json: async () => ({ ok: true, result: body.method === 'terminal.list' ? {
        sessions: [{ sessionKey: key, state: 'connected', attached: attached ? 1 : 0, attachCount: attached ? 1 : 0 }],
      } : {} }) }
    },
  }
  // Capture scenario flags outside the HTTP request options object.
  const fetchOriginal = context.fetch
  context.fetch = (url, init) => fetchOriginal(url, { ...init, noAttach: options.noAttach })
  vm.runInNewContext(bundle, context, { timeout: 1000 })
  const api = registration.factory((name) => { assert.equal(name, 'react'); return {} })
  api.configure(right, terminals)
  return { ...api, writes, views, traces, opens: () => opens, oldOpens: () => oldOpens }
}
function connect(env) {
  return env.openNativeTerminal(sessionId, command, { sessionKey: key, session: { attachCount: 0, attached: 0 } })
}

test('session-local tab2 collision does not block bridge command or select foreign/manual terminals', async () => {
  const env = setup()
  await connect(env)
  assert.equal(env.opens(), 1)
  assert.equal(env.oldOpens(), 0)
  assert.deepEqual(env.writes, [command + '\r'])
  assert.deepEqual(env.views, [[sessionId, 'tab2', 'new-terminal-address', undefined, undefined]])
  assert.ok(env.traces.some((event) => event.stage === 'attached'))
})

test('slow inventory publication beyond 800ms never opens a duplicate terminal', async () => {
  const env = setup({ publishDelay: 1500 })
  await connect(env)
  assert.equal(env.opens(), 1)
  assert.equal(env.oldOpens(), 0)
  assert.deepEqual(env.writes, [command + '\r'])
})

for (const [label, flags] of [
  ['no published terminal', { noPublish: true }],
  ['only a terminal from another session', { foreignOnly: true }],
  ['unadopted surface rejects public open', { openError: true }],
  ['closed native occurrence', { closed: true }],
  ['conversation changes before input', { switchSession: true }],
  ['native terminal startup failed', { failed: true }],
]) {
  test(`${label}: fail safely without another tab or command write`, async () => {
    const env = setup(flags)
    await assert.rejects(connect(env))
    assert.equal(env.opens(), 1)
    assert.equal(env.oldOpens(), 0)
    assert.deepEqual(env.writes, [])
  })
}

test('relay attach timeout never reopens the tab or replays bridge input', async () => {
  const env = setup({ noAttach: true })
  await assert.rejects(connect(env), (error) => error.attachFailure === true)
  assert.equal(env.opens(), 1)
  assert.equal(env.oldOpens(), 0)
  assert.deepEqual(env.writes, [command + '\r'])
})
