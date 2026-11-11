import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
function setup() {
  let registration, cursor = 0, documentMock
  const states = [], changes = [], effects = [], cleanups = [], timers = new Map()
  let timerId = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(initial) { return { current: initial } }, useEffect(fn) { effects.push(fn) },
  }
  const instrumented = source.replace('    return plugin;', `    return {
    connectHostTerminal, callApi, traceTerminal, pollConnectInitialization, readConnectProgress, subscribeConnectProgress, setConnectStage,
    setPostApi(fn) { postApi = fn; },
    setConnectProgressVisible, dismissConnectProgress, ConnectProgressOverlay, ModalShell, PasswordDialog, focusConnectedTerminal,
    configureFocus(right, sessionId) { runtimeRight = right; runtimeUiSession = { current: { getSnapshot() { return { sessionId }; } } }; },
    setImplementation(fn) { connectHostTerminalImpl = fn; },
    setPassword(value) { passwordRequest = value; },
    plugin
  };`)
  assert.notEqual(instrumented, source)
  vm.runInNewContext(instrumented, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }),
    AbortController,
    get document() { return documentMock },
  }, { timeout: 1000 })
  const api = registration.factory(() => React)
  api.subscribeConnectProgress((value) => changes.push(value))
  return { ...api, changes, timers,
    setDocument(value) { documentMock = value },
    render(reset = true) { if (reset) states.length = 0; cursor = 0; effects.length = 0; return api.ConnectProgressOverlay() },
    flushEffects() { for (const fn of effects.splice(0)) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } },
    unmount() { for (const fn of cleanups.splice(0)) fn() },
  }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const connected = { shell: {}, sessionId: 'new-session', injected: false, notice: null }
const plain = (value) => JSON.parse(JSON.stringify(value))
function text(value) { return JSON.stringify(value, (_key, item) => typeof item === 'function' ? undefined : item) }
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}

test('progress is published synchronously and guards duplicate connects across page navigation', async () => {
  const env = setup(), pending = deferred()
  let calls = 0
  env.setImplementation(() => { calls++; return pending.promise })
  const operation = env.connectHostTerminal({ name: 'target' })
  assert.equal(env.readConnectProgress().status, 'running')
  assert.equal(env.readConnectProgress().visible, true)
  assert.equal(env.readConnectProgress().name, 'target')
  await assert.rejects(env.connectHostTerminal({ name: 'other' }), /已有连接/)
  assert.equal(calls, 1)
  pending.resolve(connected)
  await operation
  assert.equal(env.readConnectProgress().status, 'success')
  assert.equal(env.readConnectProgress().visible, false)
  assert.equal(env.render(), null, 'successful connection removes both modal and collapsed launcher')
  assert.equal(env.changes[0].status, 'running')
  assert.equal(env.changes.at(-1).status, 'success')
})

test('stages only advance and stale polling updates cannot change a later attempt', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  const oldId = env.readConnectProgress().id
  env.setConnectStage('bridge', 'Waiting for verified bridge', oldId)
  env.setConnectStage('ssh', 'stale', oldId)
  assert.equal(env.readConnectProgress().stage, 3)
  assert.equal(env.readConnectProgress().detail, 'Waiting for verified bridge')
  pending.resolve(connected); await operation
  env.setImplementation(async () => { throw new Error('current failure') })
  await assert.rejects(env.connectHostTerminal({ name: 'next' }), /current failure/)
  const current = plain(env.readConnectProgress())
  env.setConnectStage('finish', 'old update', oldId)
  assert.deepEqual(plain(env.readConnectProgress()), current)
})

test('hiding progress does not cancel a connection and it can be reopened', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  env.dismissConnectProgress()
  assert.equal(env.readConnectProgress().status, 'running')
  assert.equal(env.readConnectProgress().visible, false)
  let tree = env.render()
  assert.equal(tree.type, 'button')
  assert.equal(tree.props['data-connect-progress-resume'], '')
  tree.props.onClick()
  assert.equal(env.readConnectProgress().visible, true)
  tree = env.render()
  assert.equal(tree.props.trapFocus, true)
  assert.match(text(tree), /只隐藏窗口，不会取消/)
  pending.resolve(connected); await operation
  env.dismissConnectProgress()
  assert.equal(env.readConnectProgress(), null)
})

test('failure remains visible at its actual stage and is not reported as connected', async () => {
  const env = setup()
  env.setImplementation(async () => {
    env.setConnectStage('terminal', 'Waiting for writable terminal')
    throw new Error('terminal not writable')
  })
  await assert.rejects(env.connectHostTerminal({ name: 'target' }))
  const progress = env.readConnectProgress()
  assert.equal(progress.status, 'failed')
  assert.equal(progress.stage, 2)
  assert.equal(progress.error, 'terminal not writable')
  const tree = env.render()
  assert.equal(tree.props.rootAttrs['data-connect-progress'], 'failed')
  assert.match(text(tree), /terminal not writable|连接未完成/)
  assert.doesNotMatch(text(tree), /等待你发送运维任务/)
})

test('incomplete native attachment has a distinct result instead of success', async () => {
  const env = setup()
  env.setImplementation(async () => ({ ...connected, sessionId: null, notice: 'No current native terminal' }))
  await env.connectHostTerminal({ name: 'target' })
  assert.equal(env.readConnectProgress().status, 'incomplete')
  assert.match(env.render().props.title, /连接未完成/)
})

test('password dialog exclusively owns focus and credentials are never rendered in progress', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  env.setPassword({ password: 'DO-NOT-RENDER' })
  const beneath = env.render()
  assert.notEqual(beneath, null, 'progress remains visible beneath password dialog')
  assert.equal(beneath.props.suspended, true)
  assert.equal(beneath.props.rootAttrs.inert, true)
  assert.equal(beneath.props.rootAttrs['aria-hidden'], 'true')
  assert.equal(beneath.props.rootAttrs['aria-modal'], 'false')
  assert.equal(beneath.props.layerStyle.pointerEvents, 'none')
  assert.doesNotMatch(text(beneath), /DO-NOT-RENDER/)
  env.setPassword(null)
  const tree = env.render()
  assert.equal(tree.type, env.ModalShell)
  assert.equal(tree.props.layerStyle.pointerEvents, 'auto')
  assert.doesNotMatch(text(tree), /DO-NOT-RENDER/)
  pending.resolve(connected); await operation
})

test('password arrival between render and subscription suppresses progress focus trap', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target', startNewSession: true })
  assert.notEqual(env.render(), null)
  env.setPassword({ name: 'target' })
  env.flushEffects()
  const beneath = env.render(false)
  assert.notEqual(beneath, null)
  assert.equal(beneath.props.suspended, true)
  assert.equal(beneath.props.rootAttrs.inert, true)
  assert.equal(env.timers.size, 1)
  env.unmount()
  assert.equal(env.timers.size, 0)
  env.setPassword(null)
  pending.resolve(connected); await operation
})

test('side-channel terminal opens are blocked while a global connection is running', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target', sessionId: 'current' })
  await assert.rejects(env.callApi('terminal.open', { name: 'other', sessionId: 'current' }), /已有连接/)
  env.traceTerminal('write', 'different', 'not this connection')
  assert.equal(env.readConnectProgress().stage, 0)
  pending.resolve(connected); await operation
})

test('current-session connections mark workspace creation as not applicable', async () => {
  const env = setup()
  const pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target', startNewSession: false })
  env.setConnectStage('ssh')
  const tree = env.render()
  assert.match(text(tree), /使用当前会话|沿用当前会话/)
  assert.doesNotMatch(text(tree), /保存会话名称/)
  pending.resolve(connected); await operation
  assert.equal(env.render(), null)
})

test('stopping initialization polling aborts its request and ignores a late response', async () => {
  const env = setup(), pending = deferred(), response = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  env.setConnectStage('ssh', 'still connecting')
  let requestSignal
  env.setPostApi((_method, _params, signal) => { requestSignal = signal; return response.promise })
  const stop = env.pollConnectInitialization('session', 'target')
  stop()
  assert.equal(requestSignal.aborted, true)
  response.resolve({ sessions: [{ sessionKey: 'session::target', actionProgress: { state: 'running', total: 1, index: 0, completed: 0, type: 'command' } }] })
  await Promise.resolve()
  assert.equal(env.timers.size, 0)
  assert.equal(env.readConnectProgress().detail, 'still connecting')
  pending.resolve(connected); await operation
})

test('initialization display uses only safe progress metadata and releases its polling timer', { timeout: 1000 }, async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  env.setConnectStage('ssh')
  env.setPostApi(async () => ({ sessions: [{ sessionKey: 'session::target', actionProgress: {
    state: 'running', total: 2, index: 0, completed: 0, type: 'command', label: 'Initialize',
    value: 'PRIVATE-COMMAND', output: 'PRIVATE-OUTPUT', password: 'PRIVATE-PASSWORD',
  } }] }))
  const updated = deferred()
  const unsubscribe = env.subscribeConnectProgress(value => { if (value && value.detail.includes('Initialize')) updated.resolve() })
  const stop = env.pollConnectInitialization('session', 'target')
  await updated.promise
  unsubscribe()
  assert.match(env.readConnectProgress().detail, /1\/2.*Initialize/)
  assert.doesNotMatch(env.readConnectProgress().detail, /PRIVATE/)
  assert.equal(env.timers.size, 1)
  stop()
  assert.equal(env.timers.size, 0)
  pending.resolve(connected); await operation
})

test('each step exposes distinct completed, running, pending and failed styles with text', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target', startNewSession: true })
  env.setConnectStage('terminal')
  let steps = nodes(env.render()).filter(node => node.props['data-connect-step-state'])
  assert.deepEqual(steps.map(node => node.props['data-connect-step-state']), ['complete', 'complete', 'running', 'pending', 'pending'])
  for (const step of steps) assert.match(step.props.className, new RegExp('dshr-connect-step-' + step.props['data-connect-step-state']))
  assert.match(text(steps), /已完成|进行中|待执行/)
  pending.reject(new Error('terminal failure'))
  await assert.rejects(operation)
  steps = nodes(env.render()).filter(node => node.props['data-connect-step-state'])
  assert.equal(steps[2].props['data-connect-step-state'], 'failed')
  assert.match(text(steps[2]), /失败/)
  assert.match(source, /dshr-connect-step-complete\{color:var\(--dsw-alias-state-success-primary/)
  assert.match(source, /dshr-connect-step-failed\{color:var\(--dsw-alias-state-error-primary/)
})

test('password is above visible progress while only the password modal is active', async () => {
  const env = setup(), pending = deferred()
  env.setImplementation(() => pending.promise)
  const operation = env.connectHostTerminal({ name: 'target' })
  const request = { name: 'target', busy: false, cancel() {} }
  env.setPassword(request)
  const beneath = env.render()
  const above = env.PasswordDialog({ request })
  assert.ok(above.props.layerStyle.zIndex > beneath.props.layerStyle.zIndex)
  assert.equal(beneath.props.suspended, true)
  assert.equal(beneath.props.headExtra.props.disabled, true)
  assert.equal(above.props.trapFocus, true)
  assert.notEqual(above.props.suspended, true)
  env.setPassword(null)
  const resumed = env.render()
  assert.equal(resumed.props.suspended, false)
  assert.equal(resumed.props.rootAttrs.inert, undefined)
  pending.resolve(connected); await operation
})

test('success focus fallback targets only the exact current native terminal', () => {
  const env = setup()
  let focused = 0, activeId = 'native-target', mounted = 'session'
  const input = { disabled: false, closest() { return { getClientRects() { return [{}] } } }, focus() { focused++ } }
  env.setDocument({ querySelectorAll() { return [input] } })
  env.configureFocus({ mounted: { getSnapshot() { return mounted } }, active() { return { kind: 'terminal', id: activeId } } }, 'session')
  env.focusConnectedTerminal('session', 'native-target')
  assert.equal(focused, 1)
  activeId = 'other-terminal'
  env.focusConnectedTerminal('session', 'native-target')
  assert.equal(focused, 1)
  activeId = 'native-target'; mounted = 'other-session'
  env.focusConnectedTerminal('session', 'native-target')
  assert.equal(focused, 1)
})

test('progress component is registered on the global shell overlay, not the page', () => {
  assert.match(source, /id: "dsh-remote-connect-progress", order: 90/)
  assert.match(source, /registerConnectProgressOverlay[\s\S]*?inject\("shell\.overlay"/)
})
