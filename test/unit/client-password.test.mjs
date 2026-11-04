import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const bundle = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const secret = 'unit-test-password-not-a-real-credential'
const authError = { ok: false, error: { code: 'AUTH', message: 'Authentication required' } }
const ok = (result) => ({ ok: true, result })
const turn = () => new Promise((resolve) => setImmediate(resolve))

// Exercise the hand-written lazy bundle without React/DOM/Harness dependencies.
// Only the test copy exposes closure helpers; the shipped bundle has no exports
// for credentials and still imports exclusively the baseline React module.
function setup(respond) {
  let registration
  const calls = []
  const effects = []
  const states = []
  const refs = []
  const sideEffects = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useRef(value) { return refs.shift() || { current: value } },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      states.push(value)
      return [value, (next) => { states.push(typeof next === 'function' ? next(value) : next) }]
    },
    useEffect(effect) { effects.push(effect) },
  }
  const context = {
    AbortController,
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      prompt() { sideEffects.push('prompt'); throw new Error('forbidden') },
    },
    localStorage: { setItem() { sideEffects.push('storage') } },
    console: new Proxy({}, { get: () => (...args) => { sideEffects.push(args) } }),
    fetch: async (url, options) => {
      assert.equal(url, '/dsh-remote/api')
      assert.equal(options.method, 'POST')
      assert.equal(options.credentials, 'same-origin')
      const body = JSON.parse(options.body)
      calls.push({ body, signal: options.signal })
      const payload = await respond(body, calls.length, options.signal)
      return { ok: payload.ok, status: payload.ok ? 200 : 401, json: async () => payload }
    },
  }
  const instrumented = bundle.replace('    return plugin;', `    return {
    plugin, callApi, PasswordOverlay, PasswordDialog, ModalShell,
    subscribePasswordRequest, disposePasswordRequests,
    getRequest: function () { return passwordRequest; },
    controllerCount: function () { return passwordControllers.size; },
    listenerCount: function () { return passwordListeners.size; }
    };`)
  assert.notEqual(instrumented, bundle)
  vm.runInNewContext(instrumented, context, { filename: 'client-password-test.js', timeout: 1000 })
  assert.equal(registration.id, '@aide-family/dsh-remote')
  const api = registration.factory((name) => { assert.equal(name, 'react'); return React })
  return { ...api, calls, effects, states, refs, sideEffects, context }
}

function methods(env) { return env.calls.map(({ body }) => body.method) }

test('non-AUTH errors and normal terminal opens never ask for a password', async () => {
  const env = setup(async (body) => body.name === 'works' ? ok({ shell: {} }) : {
    ok: false, error: { code: 'POLICY', message: 'Denied' },
  })
  await env.callApi('terminal.open', { name: 'works' })
  await assert.rejects(env.callApi('terminal.open', { name: 'denied' }), { code: 'POLICY', message: 'Denied' })
  assert.equal(env.getRequest(), null)
  assert.equal(env.controllerCount(), 0)
  assert.deepEqual(methods(env), ['terminal.open', 'terminal.open'])
})

test('AUTH waits for explicit submission, authenticates once, then retries original open once', async () => {
  const env = setup(async (body, index) => index === 1 ? authError : body.method === 'auth.password'
    ? ok({ authenticated: true, name: 'bastion-demo' }) : ok({ shell: { sessionKey: 'new-session::bastion-demo' } }))
  const snapshots = []
  const unsubscribe = env.subscribePasswordRequest((request) => snapshots.push(JSON.stringify(request)))
  const params = { name: 'bastion-demo', sessionId: 'new-session' }
  const opening = env.callApi('terminal.open', params)
  await turn()
  assert.deepEqual(methods(env), ['terminal.open'])
  const request = env.getRequest()
  assert.equal(request.name, 'bastion-demo')
  let cleared = 0
  request.clearInput = () => { cleared++ }
  await request.submit(secret)
  assert.equal((await opening).shell.sessionKey, 'new-session::bastion-demo')
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password', 'terminal.open'])
  assert.deepEqual(env.calls[1].body, { method: 'auth.password', name: 'bastion-demo', password: secret })
  assert.deepEqual(env.calls[2].body, env.calls[0].body)
  assert.equal(JSON.stringify([env.calls[0].body, env.calls[2].body, snapshots, env.states]).includes(secret), false)
  assert.equal(cleared, 2)
  assert.equal(env.getRequest(), null)
  assert.equal(env.controllerCount(), 0)
  // React unmount after success cannot abort the retry's controller.
  request.cancel()
  assert.equal(env.calls[2].signal.aborted, false)
  assert.deepEqual(env.sideEffects, [])
  unsubscribe()
})

test('cancel clears input and ends the request without submitting credentials or retrying', async () => {
  const env = setup(async () => authError)
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(opening, { message: '密码登录已取消', browserOnly: true })
  await turn()
  let cleared = 0
  env.getRequest().clearInput = () => { cleared++ }
  env.getRequest().cancel()
  await rejected
  assert.equal(cleared, 1)
  assert.equal(env.getRequest(), null)
  assert.deepEqual(methods(env), ['terminal.open'])
})

test('wrong password surfaces a sanitized failure and requires a fresh user connect attempt', async () => {
  const env = setup(async (body) => body.method === 'auth.password'
    ? { ok: false, error: { code: 'AUTH', message: secret, stack: secret } } : authError)
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(opening, (failure) => {
    assert.equal(failure.browserOnly, true)
    assert.equal(failure.message.includes(secret), false)
    assert.equal(String(failure.stack).includes(secret), false)
    return true
  })
  await turn()
  const request = env.getRequest()
  await request.submit(secret)
  await rejected
  await request.submit(secret) // stale dialog cannot repeat attempts
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password'])
  assert.equal(env.getRequest(), null)
  assert.deepEqual(env.sideEffects, [])
  const fresh = env.callApi('terminal.open', { name: 'bastion-demo' })
  const cancelled = assert.rejects(fresh)
  await turn()
  assert.notEqual(env.getRequest(), request)
  env.getRequest().cancel()
  await cancelled
})

for (const result of [{ authenticated: false, name: 'bastion-demo' }, { authenticated: true, name: 'other' }]) {
  test(`unconfirmed authentication cannot retry (${JSON.stringify(result)})`, async () => {
    const env = setup(async (body) => body.method === 'auth.password' ? ok(result) : authError)
    const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
    const rejected = assert.rejects(opening, { message: '密码登录失败，请重新连接后再试' })
    await turn()
    await env.getRequest().submit(secret)
    await rejected
    assert.deepEqual(methods(env), ['terminal.open', 'auth.password'])
  })
}

test('a repeated AUTH after confirmed authentication ends the flow without another prompt', async () => {
  const env = setup(async (body) => body.method === 'auth.password'
    ? ok({ authenticated: true, name: 'bastion-demo' }) : authError)
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(opening, { message: '认证后终端连接失败，请重新连接后再试' })
  await turn()
  await env.getRequest().submit(secret)
  await rejected
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password', 'terminal.open'])
  assert.equal(env.getRequest(), null)
})

test('dispose aborts in-flight authentication and removes pending requests/listeners', async () => {
  const env = setup(async (body, index, signal) => {
    if (body.method !== 'auth.password') return authError
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(secret)), { once: true })
    })
  })
  env.subscribePasswordRequest(() => {})
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(opening, { message: '密码登录已取消' })
  await turn()
  const submission = env.getRequest().submit(secret)
  env.disposePasswordRequests()
  await submission
  await rejected
  assert.equal(env.getRequest(), null)
  assert.equal(env.listenerCount(), 0)
  assert.equal(env.controllerCount(), 0)
  assert.ok(env.calls.every(({ signal }) => signal.aborted))
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password'])
  assert.deepEqual(env.sideEffects, [])
})

test('concurrent terminal opens cannot replace the current dialog', async () => {
  const env = setup(async () => authError)
  const first = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(first)
  await turn()
  const original = env.getRequest()
  await assert.rejects(env.callApi('terminal.open', { name: 'other' }), /请先完成或取消/)
  assert.equal(env.getRequest(), original)
  original.cancel()
  await rejected
})

function nodes(tree) {
  return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
}

test('dialog is masked/uncontrolled, clears on submit/cancel/unmount, and opts into root pointer events', async () => {
  const env = setup(async () => authError)
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  const rejected = assert.rejects(opening)
  await turn()
  const request = env.getRequest()
  const input = { value: secret }
  env.refs.push({ current: input })
  const tree = env.PasswordDialog({ request })
  const descendants = nodes(tree)
  const passwordInput = descendants.find((node) => node.type === 'input')
  assert.equal(passwordInput.props.type, 'password')
  assert.equal(passwordInput.props.value, undefined)
  assert.equal(passwordInput.props.defaultValue, undefined)
  assert.equal(passwordInput.props.required, true)
  assert.equal(tree.props.trapFocus, true)
  assert.equal(tree.props.layerStyle.pointerEvents, 'auto')
  assert.equal(tree.props.layerStyle.position, 'fixed')
  const cleanup = env.effects[0]()
  // Cancel clears the actual uncontrolled DOM value synchronously.
  tree.props.onClose()
  assert.equal(input.value, '')
  input.value = secret
  cleanup()
  assert.equal(input.value, '')
  await rejected
  assert.equal(JSON.stringify(env.states).includes(secret), false)
})

test('submit erases the DOM immediately and ignores repeat clicks while authentication is pending', async () => {
  let completeAuth
  const env = setup(async (body, index) => index === 1 ? authError : body.method === 'auth.password'
    ? new Promise((resolve) => { completeAuth = resolve }) : ok({ shell: {} }))
  const opening = env.callApi('terminal.open', { name: 'bastion-demo' })
  await turn()
  const input = { value: secret }
  const request = env.getRequest()
  env.refs.push({ current: input })
  const tree = env.PasswordDialog({ request })
  const cleanup = env.effects[0]()
  const form = nodes(tree).find((node) => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  assert.equal(input.value, '')
  assert.equal(request.busy, true)
  await request.submit(secret)
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password'])
  // Effect replay clears the input but must not cancel the live request.
  cleanup()
  assert.equal(env.getRequest(), request)
  completeAuth(ok({ authenticated: true, name: 'bastion-demo' }))
  await opening
  assert.deepEqual(methods(env), ['terminal.open', 'auth.password', 'terminal.open'])
})

test('modal traps Tab/focus, handles Escape, restores focus and removes document listeners', () => {
  const env = setup(async () => ok({}))
  const listeners = new Map()
  const document = {
    activeElement: null,
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || new Set()
      callbacks.add(callback); listeners.set(type, callbacks)
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
  }
  env.context.document = document
  function target() {
    return { isConnected: true, focus() { document.activeElement = this } }
  }
  const previous = target()
  const first = target()
  const last = target()
  const dialog = { ...target(), querySelectorAll: () => [first, last], contains: (node) => node === first || node === last }
  document.activeElement = previous
  env.refs.push({ current: dialog })
  let closed = 0
  const tree = env.ModalShell({ title: 'SSH password', trapFocus: true, onClose() { closed++ } })
  const cleanups = env.effects.map((effect) => effect())
  assert.equal(document.activeElement, first)
  assert.equal(tree.children[0].props.role, 'dialog')
  assert.equal(tree.children[0].props['aria-modal'], 'true')
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
    for (const callback of listeners.get('keydown')) callback(event)
    return event
  }
  last.focus()
  assert.equal(key('Tab').prevented, true)
  assert.equal(document.activeElement, first)
  assert.equal(key('Tab', true).prevented, true)
  assert.equal(document.activeElement, last)
  previous.focus()
  for (const callback of listeners.get('focusin')) callback({ target: previous })
  assert.equal(document.activeElement, first)
  key('Escape')
  assert.equal(closed, 1)
  for (const cleanup of cleanups) cleanup()
  assert.equal(document.activeElement, previous)
  assert.ok([...listeners.values()].every((callbacks) => callbacks.size === 0))
})

test('root apply registers shell.overlay globally and owns credential cleanup', () => {
  const env = setup(async () => ok({}))
  const registrations = []
  const cleanups = []
  const ctx = {
    effect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    inject() {}, // optional terminal/session services are deliberately absent
    slots: {
      inject(name, effect) { return effect() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  env.plugin.apply(ctx)
  const overlay = registrations.find(({ options }) => options.name === 'shell.overlay')
  assert.deepEqual(JSON.parse(JSON.stringify(overlay.options)), { name: 'shell.overlay', id: 'dsh-remote-auth', order: 100 })
  assert.equal(overlay.component, env.PasswordOverlay)
  assert.ok(cleanups.includes(env.disposePasswordRequests))
  for (const cleanup of cleanups) cleanup()
  assert.equal(env.listenerCount(), 0)
})
