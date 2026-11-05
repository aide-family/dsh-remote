import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))
const host = (name, extra = {}) => ({ name, target: 'ops@shared.example:22', allowed: true, source: 'ssh-config', ...extra })
const overview = (hosts, sessions = [], relays = []) => ({ hosts, sessions, audit: [], terminal: { sessions: relays } })

// Match the connection-profile tests: expose the lazy component at the plugin
// return, never add production exports or replace the implementation under test.
// Refs, unlike the older form harness, survive rerenders for the pending guard.
function setup(initialData, respond = async () => ({})) {
  let registration
  let stateCursor = 0
  let refCursor = 0
  const states = [initialData] // RemoteOpsPage's overview remains state index 0.
  const refs = []
  const calls = []
  const focused = []
  let data = initialData
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const index = stateCursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(initial) {
      const index = refCursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect() {}, // Seed overview directly; refresh requests still use the real callApi.
    useCallback(fn) { return fn },
  }
  const instrumented = source.replace('    return plugin;', '    return { RemoteOpsPage };')
  assert.notEqual(instrumented, source)
  vm.runInNewContext(instrumented, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body)
      calls.push(request)
      try {
        const result = request.method === 'overview' ? data : await respond(request)
        return { ok: true, json: async () => ({ ok: true, result }) }
      } catch (failure) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: failure.code, message: failure.message } }) }
      }
    },
  }, { timeout: 1000 })
  const api = registration.factory((name) => { assert.equal(name, 'react'); return React })
  return {
    calls, focused,
    setOverview(next) { data = next },
    render() {
      stateCursor = 0
      refCursor = 0
      const tree = api.RemoteOpsPage()
      const nav = nodes(tree).find((node) => node.props.id === 'dshr-host-nav' && node.type === 'nav')
      if (nav) {
        nav.props.ref.current = {
          querySelectorAll(selector) {
            assert.equal(selector, '[data-host-select]')
            return options(tree).map((node) => ({ focus() { focused.push(node.props['data-host-name']) } }))
          },
        }
      }
      return tree
    },
  }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}
function marked(tree, key, value = '') { return nodes(tree).find((node) => node.props[key] === value) }
function options(tree) { return nodes(tree).filter((node) => node.props['data-host-select'] === '') }
function names(tree) { return options(tree).map((node) => node.props['data-host-name']) }
function text(tree) { return JSON.stringify(tree, (_key, value) => typeof value === 'function' ? undefined : value) }
function action(tree, name) { return marked(tree, 'data-host-action', name) }
function modal(tree) { return nodes(tree).find((node) => node.props.rootAttrs?.['data-dsh-remote-confirm'] === 'close-host') }
function confirmation(tree, name) {
  const dialog = modal(tree)
  assert.ok(dialog, 'close confirmation is open')
  const button = marked(dialog.props.footer, 'data-confirm-action', name)
  assert.ok(button, `confirmation has ${name} action`)
  return button
}
function search(env, query) {
  marked(env.render(), 'data-host-search').props.onChange({ target: { value: query } })
  return env.render()
}
function select(env, name) {
  const option = options(env.render()).find((node) => node.props['data-host-name'] === name)
  assert.ok(option, `${name} is selectable`)
  option.props.onClick()
  return env.render()
}
function openClose(env) {
  const close = action(env.render(), 'close')
  assert.ok(close, 'selected host exposes close for retained SSH sessions')
  close.props.onClick()
  return env.render()
}
function failure(code, message = code) { return Object.assign(new Error(message), { code }) }
function closeRequests(env) { return env.calls.filter((call) => call.method === 'session.close' || call.method === 'terminal.close') }

const searchable = host('Alpha-Prod', {
  target: 'Root@Target.Example:2200', host: 'Address.Example', username: 'DeployUser',
  viaHost: 'Jump-Entry', description: 'Blue Database', source: 'Managed-Config', tags: ['West', 'Critical'],
})

test('host search is case-insensitive across all supported fields and ANDs whitespace-separated terms', () => {
  const env = setup(overview([searchable, host('Beta', { tags: ['West'], description: 'Blue cache' }), host('Gamma')]))
  for (const query of ['ALPHA-PROD', 'TARGET.EXAMPLE', 'ADDRESS.EXAMPLE', 'DEPLOYUSER', 'JUMP-ENTRY', 'DATABASE', 'MANAGED-CONFIG', 'CRITICAL']) {
    assert.deepEqual(names(search(env, query)), ['Alpha-Prod'], `search ${query}`)
  }
  assert.deepEqual(names(search(env, '  wEsT\tBLUE\nDEPLOYUSER  ')), ['Alpha-Prod'])
  assert.deepEqual(names(search(env, 'ALPHA-PROD cache')), [], 'terms must all match one host, not different hosts')
  assert.deepEqual(names(search(env, '  \t\n ')), ['Alpha-Prod', 'Beta', 'Gamma'])
  assert.deepEqual(env.calls, [], 'local filtering does not request overview')
})

test('empty search results announce counts, hide stale selected actions, and clear button or Escape restores hosts', () => {
  const env = setup(overview([host('Alpha'), host('Beta')]))
  select(env, 'Beta')
  let tree = search(env, 'not-a-host')
  assert.deepEqual(names(tree), [])
  assert.equal(action(tree, 'connect'), undefined)
  assert.match(text(tree), /没有匹配的连接/)
  assert.match(text(tree), /没有匹配的 SSH 连接/)
  const count = marked(tree, 'id', 'dshr-host-search-count')
  assert.equal(count.props.role, 'status')
  assert.equal(count.props['aria-live'], 'polite')
  assert.match(text(count), /找到 0 \/ 2 台主机/)
  const input = marked(tree, 'data-host-search')
  assert.equal(input.props.type, 'search')
  assert.equal(input.props['aria-controls'], 'dshr-host-nav')
  assert.equal(input.props['aria-describedby'], count.props.id)
  marked(tree, 'data-host-search-clear').props.onClick()
  tree = env.render()
  assert.deepEqual(names(tree), ['Alpha', 'Beta'])
  assert.equal(options(tree).find((node) => node.props.tabIndex === 0).props['data-host-name'], 'Beta')
  tree = search(env, 'not-a-host')
  marked(tree, 'data-host-search').props.onKeyDown({ key: 'Enter' })
  assert.deepEqual(names(env.render()), [], 'unrelated keys leave the query alone')
  marked(tree, 'data-host-search').props.onKeyDown({ key: 'Escape' })
  tree = env.render()
  assert.equal(marked(tree, 'data-host-search').props.value, '')
  assert.deepEqual(names(tree), ['Alpha', 'Beta'])
  assert.deepEqual(env.calls, [])
})

test('keyboard selection uses filtered order, moves focus, clamps boundaries and keeps one roving tab stop', () => {
  const env = setup(overview([host('hidden'), host('first', { tags: ['keep'] }), host('middle', { tags: ['keep'] }), host('last', { tags: ['keep'] })]))
  select(env, 'hidden')
  let tree = search(env, 'KEEP')
  assert.deepEqual(names(tree), ['first', 'middle', 'last'])
  const selected = () => {
    const stops = options(tree).filter((node) => node.props.tabIndex === 0)
    assert.equal(stops.length, 1)
    assert.equal(stops[0].props['aria-current'], 'page')
    for (const node of options(tree).filter((node) => node !== stops[0])) {
      assert.equal(node.props.tabIndex, -1)
      assert.equal(node.props['aria-current'], undefined)
    }
    assert.match(text(marked(tree, 'id', 'dshr-selected-host-title')), new RegExp(stops[0].props['data-host-name']))
    return stops[0]
  }
  assert.equal(selected().props['data-host-name'], 'first', 'filtered-out selection falls back to first visible host')
  for (const [key, expected] of [['ArrowDown', 'middle'], ['End', 'last'], ['ArrowDown', 'last'], ['ArrowUp', 'middle'], ['Home', 'first'], ['ArrowUp', 'first']]) {
    let prevented = 0
    selected().props.onKeyDown({ key, preventDefault() { prevented++ } })
    tree = env.render()
    assert.equal(prevented, 1)
    assert.equal(selected().props['data-host-name'], expected)
    assert.equal(env.focused.at(-1), expected)
  }
  const before = env.focused.length
  selected().props.onKeyDown({ key: 'Enter', preventDefault() { assert.fail('unhandled key prevented') } })
  assert.equal(env.focused.length, before)
  options(tree)[2].props.onClick()
  tree = env.render()
  assert.equal(selected().props['data-host-name'], 'last', 'click also updates roving selection')
})

test('closing requires explicit confirmation; footer cancel and modal dismissal send no requests', () => {
  const env = setup(overview([host('Alpha')], [{ host: 'Alpha', sessionId: 'shell-a', status: 'running' }]))
  let tree = openClose(env)
  assert.deepEqual(env.calls, [])
  assert.equal(modal(tree).props.trapFocus, true)
  assert.match(text(modal(tree)), /所有对话/)
  assert.match(text(modal(tree)), /任务可能被中断/)
  assert.match(text(modal(tree)), /连接配置会保留/)
  confirmation(tree, 'cancel').props.onClick()
  assert.equal(modal(env.render()), undefined)
  tree = openClose(env)
  modal(tree).props.onClose()
  assert.equal(modal(env.render()), undefined)
  assert.deepEqual(env.calls, [])
})

test('close targets the exact selected logical host in both registries across conversations, including exited and unhealthy entries', async () => {
  const env = setup(overview([host('Alpha-extra'), host('Alpha'), host('alpha')], [
    { host: 'Alpha', sessionId: 'shell-running', status: 'running', ownerSessionId: 'conversation-1' },
    { host: 'Alpha', sessionId: 'shell-exited', status: 'exited', ownerSessionId: 'conversation-2' },
    { host: 'Alpha-extra', sessionId: 'shell-other', status: 'running' },
    { host: 'alpha', sessionId: 'shell-case', status: 'running' },
  ], [
    ...['connected', 'error', 'connecting', 'reconnecting', 'exited'].map((state, index) => ({ host: 'Alpha', sessionKey: `relay-${state}`, state, sessionId: `conversation-${index + 1}` })),
    { host: 'Alpha', sessionKey: 'relay-closed', state: 'closed' },
    { host: 'Alpha-extra', sessionKey: 'relay-other', state: 'connected' },
    { host: 'alpha', sessionKey: 'relay-case', state: 'connected' },
  ]))
  select(env, 'Alpha') // Explicitly select a host other than the default first row.
  const treeBeforeConfirm = openClose(env)
  assert.deepEqual(env.calls, [], 'selection and opening the dialog do not close sessions')
  await confirmation(treeBeforeConfirm, 'ok').props.onClick()
  assert.deepEqual(closeRequests(env), [
    { method: 'session.close', sessionId: 'shell-running' },
    { method: 'session.close', sessionId: 'shell-exited' },
    ...['connected', 'error', 'connecting', 'reconnecting', 'exited'].map((state) => ({ method: 'terminal.close', sessionKey: `relay-${state}` })),
  ])
  assert.equal(env.calls.at(-1).method, 'overview')
  const tree = env.render()
  assert.equal(modal(tree), undefined)
  const notice = nodes(tree).find((node) => node.props.notice)?.props.notice
  assert.equal(notice.kind, 'info')
  assert.match(notice.text, /Alpha.*连接配置已保留/)
  assert.equal(env.calls.some((call) => call.method === 'host.delete'), false)
})

for (const state of ['error', 'connecting', 'reconnecting']) {
  test(`a host with only a ${state} relay can close its retained connection`, async () => {
    const env = setup(overview([host('Alpha')], [], [{ host: 'Alpha', sessionKey: 'relay', state }]))
    await confirmation(openClose(env), 'ok').props.onClick()
    assert.deepEqual(closeRequests(env), [{ method: 'terminal.close', sessionKey: 'relay' }])
  })
}

test('a host with only exited manager entries can clean up those retained Agent shells', async () => {
  const env = setup(overview([host('Alpha')], [{ host: 'Alpha', sessionId: 'exited-shell', status: 'exited' }]))
  await confirmation(openClose(env), 'ok').props.onClick()
  assert.deepEqual(closeRequests(env), [{ method: 'session.close', sessionId: 'exited-shell' }])
})

test('close deduplicates shell IDs and relay keys independently and skips missing identifiers', async () => {
  const env = setup(overview([host('Alpha')], [
    { host: 'Alpha', sessionId: 'shared-id', status: 'running' },
    { host: 'Alpha', sessionId: 'shared-id', status: 'exited' },
    { host: 'Alpha', status: 'running' },
    { host: 'Alpha', sessionId: '', status: 'running' },
  ], [
    { host: 'Alpha', sessionKey: 'shared-id', state: 'connected' },
    { host: 'Alpha', sessionKey: 'shared-id', state: 'reconnecting' },
    { host: 'Alpha', state: 'error' },
    { host: 'Alpha', sessionKey: '', state: 'connecting' },
  ]))
  await confirmation(openClose(env), 'ok').props.onClick()
  assert.deepEqual(closeRequests(env), [
    { method: 'session.close', sessionId: 'shared-id' },
    { method: 'terminal.close', sessionKey: 'shared-id' },
  ])
})

test('NO_SESSION and TERMINAL_NOT_FOUND are benign, including shared-shell relay cleanup races', async () => {
  const env = setup(overview([host('Alpha')], [
    { host: 'Alpha', sessionId: 'gone-shell', status: 'running' },
    { host: 'Alpha', sessionId: 'ok-shell', status: 'running' },
  ], [
    { host: 'Alpha', sessionKey: 'gone-relay', state: 'connected' },
    { host: 'Alpha', sessionKey: 'ok-relay', state: 'error' },
  ]), async (request) => {
    if (request.sessionId === 'gone-shell') throw failure('NO_SESSION')
    if (request.sessionKey === 'gone-relay') throw failure('TERMINAL_NOT_FOUND')
    return {}
  })
  await confirmation(openClose(env), 'ok').props.onClick()
  assert.equal(closeRequests(env).length, 4, 'benign missing entries do not stop later closes')
  assert.equal(modal(env.render()), undefined)
  assert.equal(env.calls.at(-1).method, 'overview')
})

test('partial failures continue through both registries, report errors and retry only failed identifiers', async () => {
  const attempts = new Map()
  const env = setup(overview([host('Alpha')], [
    { host: 'Alpha', sessionId: 'bad-shell', status: 'running' },
    { host: 'Alpha', sessionId: 'bad-shell', status: 'exited' },
    { host: 'Alpha', sessionId: 'good-shell', status: 'running' },
  ], [
    { host: 'Alpha', sessionKey: 'bad-relay', state: 'error' },
    { host: 'Alpha', sessionKey: 'bad-relay', state: 'reconnecting' },
    { host: 'Alpha', sessionKey: 'good-relay', state: 'connected' },
  ]), async (request) => {
    const key = request.sessionId || request.sessionKey
    attempts.set(key, (attempts.get(key) || 0) + 1)
    if (key.startsWith('bad') && attempts.get(key) === 1) throw failure('CLOSE_FAILED', `${key} refused`)
    return {}
  })
  await confirmation(openClose(env), 'ok').props.onClick()
  assert.deepEqual(closeRequests(env), [
    { method: 'session.close', sessionId: 'bad-shell' },
    { method: 'session.close', sessionId: 'good-shell' },
    { method: 'terminal.close', sessionKey: 'bad-relay' },
    { method: 'terminal.close', sessionKey: 'good-relay' },
  ])
  let tree = env.render()
  const alert = marked(modal(tree), 'role', 'alert')
  assert.ok(alert)
  assert.match(text(alert), /部分连接关闭失败，请重试/)
  assert.match(text(alert), /bad-shell refused/)
  assert.match(text(alert), /bad-relay refused/)
  assert.equal(confirmation(tree, 'ok').props.disabled, false)
  assert.equal(action(tree, 'connect').props.disabled, false)
  // Even if overview no longer lists the failures, the confirmation retains
  // exactly the failed snapshot rather than re-closing all current entries.
  env.setOverview(overview([host('Alpha')]))
  await confirmation(tree, 'ok').props.onClick()
  assert.deepEqual(closeRequests(env).slice(4), [
    { method: 'session.close', sessionId: 'bad-shell' },
    { method: 'terminal.close', sessionKey: 'bad-relay' },
  ])
  assert.equal(env.calls.filter((call) => call.method === 'overview').length, 2)
  tree = env.render()
  assert.equal(modal(tree), undefined)
  assert.equal(action(tree, 'close'), undefined)
})

test('pending close synchronously guards repeated confirmation and disables connect, close and cancellation until completion', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const env = setup(overview([host('Alpha'), host('Beta')], [{ host: 'Alpha', sessionId: 'shell', status: 'running' }]), async () => pending)
  const tree = openClose(env)
  const confirm = confirmation(tree, 'ok')
  const first = confirm.props.onClick()
  await confirm.props.onClick() // Same stale render: guard must not rely on state.
  assert.deepEqual(closeRequests(env), [{ method: 'session.close', sessionId: 'shell' }])
  let busyTree = env.render()
  assert.equal(confirmation(busyTree, 'ok').props.disabled, true)
  assert.equal(confirmation(busyTree, 'cancel').props.disabled, true)
  assert.equal(action(busyTree, 'close').props.disabled, true)
  assert.equal(action(busyTree, 'connect').props.disabled, true)
  confirmation(busyTree, 'cancel').props.onClick()
  modal(busyTree).props.onClose()
  assert.ok(modal(env.render()), 'pending close cannot dismiss confirmation')
  await confirmation(env.render(), 'ok').props.onClick() // Rerendered ref must also guard.
  assert.equal(closeRequests(env).length, 1)
  busyTree = select(env, 'Beta')
  assert.equal(action(busyTree, 'connect').props.disabled, true, 'other selected hosts cannot connect while close is pending')
  env.setOverview(overview([host('Alpha'), host('Beta')]))
  release({})
  await first
  const done = env.render()
  assert.equal(modal(done), undefined)
  assert.equal(action(done, 'connect').props.disabled, false)
  assert.equal(closeRequests(env).length, 1)
  assert.equal(env.calls.at(-1).method, 'overview')
})

test('connection rail keeps fixed desktop/mobile heights with scrollable, non-shrinking options', () => {
  assert.match(source, /\.dshr-connections\{[^}]*height:480px/)
  assert.match(source, /@media \(max-width:720px\)\{[^\n]*\.dshr-connections\{height:320px\}/)
  assert.match(source, /\.dshr-host-nav\{[^}]*flex:1;[^}]*min-height:0;[^}]*overflow-y:auto/)
  assert.match(source, /\.dshr-host-nav \.dshr-host-option\{flex:none\}/)
})
