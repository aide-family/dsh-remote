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
  const events = []
  const titles = []
  const terminalNames = []
  const messages = []
  const workspaceCreates = []
  const sessionCreates = []
  const workspaces = { async create(input) {
    events.push('workspace.create')
    workspaceCreates.push(input.path)
    if (options.workspaceError) throw new Error('workspace registry failed')
    return { workspaceId: 'workspace-remote-ops' }
  } }
  const sessions = {
    async create(input) {
      events.push('session.create')
      sessionCreates.push(JSON.parse(JSON.stringify(input)))
      if (options.sessionError) throw new Error('session create failed')
      return sessionId
    },
    scope(sid) {
      assert.equal(sid, sessionId)
      return { conversation: { async send(text) { messages.push(text); events.push('send') } } }
    },
    async using(sid, reason, fn) {
      assert.equal(sid, sessionId)
      assert.equal(reason.source, 'workspaceOperation')
      return fn({ binding: { session: { async rename(title) {
        events.push('rename')
        titles.push(title)
        return options.renameError ? { ok: false, error: { message: 'rename denied' } } : { ok: true, value: { title, seq: 1 } }
      } } } })
    },
  }
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
  let nativeTitle = '', nativeRenameFailed = false
  const view = {
    async rename(title) {
      terminalNames.push(title)
      events.push('terminal.rename')
      if (options.nativeRenameError) { nativeRenameFailed = true; return }
      nativeTitle = title
      if (options.switchAfterRename) mounted = 'different-conversation'
    },
    state: { getSnapshot() {
      if (options.closed) signal.aborted = true
      if (options.switchSession) mounted = 'different-conversation'
      return options.failed || nativeRenameFailed ? { phase: 'failed', title: nativeTitle, writable: false } : { phase: 'connected', info: { state: 'running', title: nativeTitle }, title: nativeTitle, writable: true }
    } },
    write(value) { writes.push(value); events.push('write') },
    mount() { assert.fail('native body exclusively owns mount') },
    dispose() { assert.fail('borrowed native view must not be disposed') },
  }
  if (options.noRename) delete view.rename
  const terminals = { view(...args) { views.push(args); return view } }
  const bundle = source.replace('    return plugin;', `    return {
      openNativeTerminal, connectHostTerminal, readPendingConnectNotice, readConnectProgress, subscribeConnectProgress,
      configure: function (right, terminals, sessions, workspace, workspaces, currentId) {
        runtimeRight = right; runtimeTerminals = terminals;
        runtimeSessions = sessions; runtimeUiWorkspace = workspace;
        runtimeUiSession = { current: { getSnapshot: function () { return { sessionId: currentId }; } } };
        runtimeCtx = { get: function (name) { return name === 'workspaces' ? workspaces : undefined; } };
      }
    };`)
  assert.notEqual(source, bundle)
  const scenario = options
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    Date: { now: () => clock },
    setTimeout(fn, delay) { clock += delay; queueMicrotask(fn); return 1 },
    clearTimeout() {},
    AbortController,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      if (body.method === 'terminal.trace') traces.push(body)
      if (body.method === 'workspace.prepare') {
        events.push('workspace.prepare')
        return { ok: true, json: async () => scenario.prepareError
          ? { ok: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: 'prepare failed' } }
          : { ok: true, result: { cwd: '/fixture/dsh/workspaces/remote-ops' } } }
      }
      if (body.method === 'terminal.open') {
        assert.equal(body.name, 'bastion-demo')
        assert.equal(body.sessionId, sessionId)
        events.push('terminal.open')
        return { ok: true, json: async () => ({ ok: true, result: {
          shell: { command, sessionKey: key, host: { target: 'ops@example:22' } },
          session: { attachCount: 0, attached: 0 },
        } }) }
      }
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
  api.configure(right, terminals, options.noNaming ? { create: sessions.create, scope: sessions.scope } : sessions, {
    startSession() { assert.fail('must not use the current workspace or reuse its blank session') },
    openSession(id) { assert.equal(id, sessionId); events.push('openSession') },
  }, options.noWorkspaces ? undefined : workspaces, options.staleCurrent ? 'conversation-old' : sessionId)
  return { ...api, writes, views, traces, events, titles, terminalNames, messages, workspaceCreates, sessionCreates, opens: () => opens, oldOpens: () => oldOpens }
}
function connect(env) {
  return env.openNativeTerminal(sessionId, command, { sessionKey: key, session: { attachCount: 0, attached: 0 } })
}
function quickConnect(env, extra = {}) {
  return env.connectHostTerminal({ name: 'bastion-demo', sessionId: 'conversation-old', startNewSession: true, talk: false, ...extra })
}

test('quick connect opens the terminal, names SSH + action, and never submits an Agent message', async () => {
  const env = setup()
  const result = await quickConnect(env)
  assert.equal(result.sessionId, sessionId)
  assert.equal(result.injected, false)
  assert.equal(result.notice, null)
  assert.deepEqual(env.titles, ['bastion-demo · 远程运维'])
  assert.deepEqual(env.terminalNames, ['bastion-demo'])
  assert.deepEqual(env.messages, [])
  assert.equal(env.readConnectProgress().status, 'success')
  assert.equal(env.readConnectProgress().stage, 4)
  assert.deepEqual(env.events, ['workspace.prepare', 'workspace.create', 'session.create', 'openSession', 'terminal.open', 'openSession', 'terminal.rename', 'write', 'rename'])
  assert.ok(env.traces.some((trace) => trace.stage === 'attached'))
  assert.deepEqual(env.workspaceCreates, ['/fixture/dsh/workspaces/remote-ops'])
  assert.deepEqual(env.sessionCreates, [{ workspaceId: 'workspace-remote-ops' }])
})

for (const flags of [{ prepareError: true }, { workspaceError: true }, { sessionError: true }, { noWorkspaces: true }, { staleCurrent: true }]) {
  test(`fixed-workspace failures never fall back to the current project or open SSH: ${JSON.stringify(flags)}`, async () => {
    const env = setup(flags)
    await assert.rejects(quickConnect(env))
    assert.equal(env.events.includes('terminal.open'), false)
    assert.deepEqual(env.writes, [])
    assert.deepEqual(env.messages, [])
    assert.ok(env.readPendingConnectNotice())
  })
}

test('explicit Agent handoff still sends after attachment and uses SSH + health-check title', async () => {
  const env = setup()
  const result = await quickConnect(env, { talk: true })
  assert.equal(result.injected, true)
  assert.deepEqual(env.titles, ['bastion-demo · 健康检查'])
  assert.equal(env.messages.length, 1)
  assert.match(env.messages[0], /只读健康检查/)
  assert.deepEqual(env.events, ['workspace.prepare', 'workspace.create', 'session.create', 'openSession', 'terminal.open', 'openSession', 'terminal.rename', 'write', 'rename', 'send'])
})

test('opening a terminal in the current conversation does not rename it or send a task', async () => {
  const env = setup()
  const result = await quickConnect(env, { startNewSession: false, sessionId })
  assert.equal(result.injected, false)
  assert.deepEqual(env.events, ['terminal.open', 'openSession', 'terminal.rename', 'write'])
  assert.deepEqual(env.titles, [])
  assert.deepEqual(env.messages, [])
})

for (const flags of [{ renameError: true }, { noNaming: true }]) {
  test(`quick-connect naming failure is surfaced without an Agent message: ${JSON.stringify(flags)}`, async () => {
    const env = setup(flags)
    await assert.rejects(quickConnect(env), /会话.*名称|会话命名/)
    assert.deepEqual(env.messages, [])
    assert.ok(env.readPendingConnectNotice())
    assert.equal(env.writes.length, 1, 'existing SSH connection is not replayed')
  })
}

test('failed bridge attachment neither names the session nor starts an Agent', async () => {
  const env = setup({ noAttach: true })
  await assert.rejects(quickConnect(env), (error) => error.attachFailure === true)
  assert.deepEqual(env.titles, [])
  assert.deepEqual(env.messages, [])
})

test('native tab title prefers the logical SSH alias, not the entrance address', async () => {
  const env = setup()
  await env.openNativeTerminal(sessionId, command, { sessionKey: key,
    shell: { host: { name: 'cluster-alias', target: 'ops@entrance.example:22' } },
    session: { attachCount: 0, attached: 0 },
  })
  assert.deepEqual(env.terminalNames, ['cluster-alias'])
  assert.deepEqual(env.writes, [command + '\r'])
})

test('long SSH lookup names respect the native 120-character display limit', async () => {
  const env = setup()
  const name = 'ssh-' + 'a'.repeat(140)
  await env.openNativeTerminal(sessionId, command, { sessionKey: key,
    shell: { host: { name } }, session: { attachCount: 0, attached: 0 },
  })
  assert.deepEqual(env.terminalNames, [name.slice(0, 120)])
  assert.deepEqual(env.writes, [command + '\r'])
})

for (const flags of [{ noRename: true }, { nativeRenameError: true }, { switchAfterRename: true }]) {
  test(`failed tab naming or navigation change cannot write the bridge command: ${JSON.stringify(flags)}`, async () => {
    const env = setup(flags)
    await assert.rejects(connect(env))
    assert.deepEqual(env.writes, [])
    assert.equal(env.opens(), 1)
  })
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
