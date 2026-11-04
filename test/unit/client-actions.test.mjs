import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const plain = (value) => JSON.parse(JSON.stringify(value))

// Exercise the actual lazy bundle helpers and element logic, not a GUI preview.
function setup() {
  let registration
  let cursor = 0
  let states = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(value) { return { current: value } },
    useEffect() {}, useLayoutEffect() {}, useCallback(fn) { return fn },
  }
  const instrumented = source.replace('    return plugin;', '    return { emptyHostForm, buildHostInput, buildActionInput, reorderActions, renderActionEditor, actionProgressText, connectionProfileLabel, handoffMessage, RemoteTerminalPanel, RemoteOpsPage };')
  assert.notEqual(instrumented, source)
  vm.runInNewContext(instrumented, { window: { __ModuleLoader__: { load(value) { registration = value } } } }, { timeout: 1000 })
  assert.equal(registration.id, '@aide-family/dsh-remote')
  const api = registration.factory((name) => { assert.equal(name, 'react'); return React })
  return { ...api, render(component, props) { cursor = 0; return component(props) }, setStates(value) { states = value } }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}
function field(tree, index, key) { return nodes(tree).find((node) => node.props['data-action-index'] === index && node.props['data-action-field'] === key) }
function button(tree, key, index) { return nodes(tree).find((node) => node.props['data-action-control'] === key && (index === undefined || node.props['data-action-index'] === index)) }
function text(tree) { return JSON.stringify(tree, (_key, value) => typeof value === 'function' ? undefined : value) }

const allActions = [
  { type: 'command', value: 'hostname', label: 'Check target', expect: 'target.example', timeoutMs: 120000 },
  { type: 'text', value: 'select target', expect: 'Selected', timeoutMs: 100 },
  { type: 'key', value: 'Enter' },
  { type: 'wait', value: 'Ready\n$ ', timeoutMs: 30000 },
  { type: 'delay', durationMs: 0 },
]

test('all action types create/update payloads preserve exact order and raw literal content', () => {
  const env = setup()
  const host = { name: 'target', viaHost: 'entry', actions: allActions, loginCommand: 'sww -r -u old legacy', tags: ['prod'], description: 'Test' }
  const form = env.emptyHostForm(host)
  assert.deepEqual(plain(form.actions), allActions)
  form.actions[0].value = 'hostname -f'
  assert.equal(host.actions[0].value, 'hostname')
  const input = env.buildHostInput({ ...form, password: 'never-save', passwordEnv: 'SECRET', identityFile: '/old', host: 'entry' })
  assert.deepEqual(plain(input), { name: 'target', viaHost: 'entry', actions: [{ ...allActions[0], value: 'hostname -f' }, ...allActions.slice(1)], tags: ['prod'], description: 'Test' })
  input.actions[0].value = 'changed'
  assert.equal(form.actions[0].value, 'hostname -f')
})

test('legacy migration preserves target root condition while explicit actions win including empty arrays', () => {
  const env = setup()
  const legacy = { name: 'target', viaHost: 'entry', loginCommand: 'sww -r -u ops target' }
  assert.deepEqual(plain(env.emptyHostForm(legacy).actions), [{ type: 'command', value: legacy.loginCommand, expectCluster: 'target' }])
  assert.deepEqual(plain(env.emptyHostForm({ ...legacy, actions: allActions }).actions), allActions)
  assert.throws(() => env.buildHostInput(env.emptyHostForm({ ...legacy, actions: [] })), /1–32/)
  assert.throws(() => env.buildHostInput(env.emptyHostForm({ ...legacy, loginCommand: 'not legacy' })), /动作内容/)
})

test('empty optional values disappear, numeric editor strings become bounded integers', () => {
  const env = setup()
  assert.deepEqual(plain(env.buildActionInput([
    { type: 'command', value: ' whoami ', label: '', expect: '', expectCluster: '', timeoutMs: '' },
    { type: 'text', value: ' a ', timeoutMs: '100' }, { type: 'delay', durationMs: '120000' },
  ])), [{ type: 'command', value: ' whoami ' }, { type: 'text', value: ' a ', timeoutMs: 100 }, { type: 'delay', durationMs: 120000 }])
})

for (const [name, rows] of [
  ['no rows', []], ['too many rows', Array.from({ length: 33 }, () => ({ type: 'key', value: 'Tab' }))],
  ['unknown type', [{ type: 'password', value: 'x' }]], ['null row', [null]],
  ['newline command', [{ type: 'command', value: 'echo a\nwhoami' }]],
  ['raw escape', [{ type: 'text', value: '\u001b' }]], ['DEL', [{ type: 'text', value: '\u007f' }]],
  ['oversize input', [{ type: 'text', value: 'x'.repeat(4097) }]],
  ['unknown key', [{ type: 'key', value: 'Ctrl-Z' }]],
  ['empty wait', [{ type: 'wait', value: '' }]], ['escape wait', [{ type: 'wait', value: '\u001b' }]],
  ['oversize expect', [{ type: 'key', value: 'Enter', expect: 'x'.repeat(2049) }]],
  ['NUL expect', [{ type: 'command', value: 'whoami', expect: '\u0000' }]],
  ['timeout too short', [{ type: 'wait', value: 'x', timeoutMs: 99 }]],
  ['timeout too long', [{ type: 'text', value: 'x', timeoutMs: 120001 }]],
  ['fractional timeout', [{ type: 'command', value: 'whoami', timeoutMs: 100.5 }]],
  ['delay missing', [{ type: 'delay' }]], ['delay blank', [{ type: 'delay', durationMs: '' }]],
  ['delay null', [{ type: 'delay', durationMs: null }]], ['delay boolean', [{ type: 'delay', durationMs: false }]],
  ['timeout object', [{ type: 'wait', value: 'x', timeoutMs: [100] }]],
  ['delay negative', [{ type: 'delay', durationMs: -1 }]], ['delay too long', [{ type: 'delay', durationMs: 120001 }]],
  ['cluster unsafe', [{ type: 'command', value: 'hostname', expectCluster: '$(id)' }]],
  ['mutually exclusive completion', [{ type: 'command', value: 'hostname', expectCluster: 'target', expect: 'target' }]],
  ['label control', [{ type: 'text', value: 'x', label: 'bad\nlabel' }]],
  ['label too long', [{ type: 'text', value: 'x', label: 'x'.repeat(81) }]],
  ['password field', [{ type: 'text', value: 'x', password: 'never-save' }]],
  ['token field', [{ type: 'command', value: 'whoami', token: 'never-save' }]],
  ['unsupported expectCluster', [{ type: 'text', value: 'x', expectCluster: 'target' }]],
  ['unexpected regex', [{ type: 'wait', value: 'x', regex: true }]],
]) {
  test(`editor rejects ${name}`, () => assert.throws(() => setup().buildActionInput(rows)))
}

test('literal metacharacters stay literal; all named keys and boundary input lengths are accepted', () => {
  const env = setup()
  const rows = [{ type: 'command', value: 'x'.repeat(4096), label: 'x'.repeat(80) }, { type: 'wait', value: 'x'.repeat(2048) }, { type: 'text', value: 'x', expect: '[.*]$\n' }]
  for (const key of ['Enter', 'Tab', 'Escape', 'Ctrl-C', 'Ctrl-D', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']) rows.push({ type: 'key', value: key })
  assert.deepEqual(plain(env.buildActionInput(rows)), rows)
})

test('reordering is immutable and preserves each completion condition', () => {
  const env = setup()
  const rows = allActions.map((row) => ({ ...row }))
  assert.deepEqual(plain(env.reorderActions(rows, 1, -1)), [rows[1], rows[0], ...rows.slice(2)])
  assert.deepEqual(plain(env.reorderActions(rows, 0, -1)), rows)
  assert.deepEqual(plain(env.reorderActions(rows, 4, 1)), rows)
  assert.deepEqual(rows, allActions)
})

test('editor add/remove/move/type changes produce relevant labeled controls only', () => {
  const env = setup()
  let rows = [{ type: 'command', value: 'hostname', expectCluster: 'target', label: 'Target' }]
  function render(busy = false) { return env.renderActionEditor({ actions: rows, busy, onChange(next) { rows = plain(next) } }) }
  let tree = render()
  assert.equal(button(tree, 'up', 0).props.disabled, true)
  assert.equal(button(tree, 'down', 0).props.disabled, true)
  assert.equal(button(tree, 'remove', 0).props.disabled, true)
  button(tree, 'add').props.onClick()
  assert.equal(rows.length, 2)
  tree = render()
  button(tree, 'down', 0).props.onClick()
  assert.equal(rows[1].expectCluster, 'target')
  tree = render()
  field(tree, 1, 'type').props.onChange({ target: { value: 'delay' } })
  assert.deepEqual(rows[1], { type: 'delay', durationMs: 1000, label: 'Target' })
  tree = render()
  assert.ok(field(tree, 1, 'durationMs'))
  assert.equal(field(tree, 1, 'value'), undefined)
  assert.equal(field(tree, 1, 'timeoutMs'), undefined)
  assert.equal(field(tree, 1, 'expectCluster'), undefined)
  field(tree, 1, 'type').props.onChange({ target: { value: 'key' } })
  tree = render()
  assert.equal(field(tree, 1, 'value').type, 'select')
  assert.equal(field(tree, 1, 'value').props.value, 'Enter')
  assert.equal(field(tree, 1, 'expectCluster'), undefined)
  button(tree, 'remove', 0).props.onClick()
  assert.equal(rows.length, 1)
  tree = render(true)
  assert.ok(nodes(tree).filter((node) => ['input', 'select', 'textarea', 'button'].includes(node.type)).every((node) => node.props.disabled))
  for (const node of nodes(tree).filter((node) => ['input', 'select', 'textarea'].includes(node.type))) {
    assert.ok(nodes(tree).some((label) => label.type === 'label' && label.props.htmlFor === node.props.id))
  }
  rows = Array.from({ length: 32 }, () => ({ type: 'key', value: 'Tab' }))
  assert.equal(button(render(), 'add').props.disabled, true)
  button(render(), 'add').props.onClick()
  assert.equal(rows.length, 32)
})

test('completion hints distinguish prompt return from successful target login and interaction completion', () => {
  const env = setup()
  const tree = env.renderActionEditor({ actions: allActions, onChange() {} })
  assert.match(text(tree), /默认等待 Shell 提示符，不校验退出码；切换登录目标请指定目标成功输出或集群 root 提示符/)
  assert.match(field(tree, 0, 'expect').props['aria-describedby'], /dshr-action-0-completion-hint/)
  assert.match(text(tree), /无预期输出时发送即完成，请用后续 wait 等待交互完成/)
  assert.match(text(tree), /第一步可用 wait 等待非 Shell \/ 菜单式入口的指定文字/)
})

test('progress only renders safe counts/type/label and explicit stop outcomes', () => {
  const env = setup()
  const progress = { state: 'running', total: 5, index: 1, completed: 1, type: 'text', label: 'Select target', value: 'PRIVATE INPUT', output: 'PRIVATE OUTPUT', password: 'SECRET' }
  assert.match(env.actionProgressText(progress), /第 2\/5 步.*text.*Select target/)
  assert.doesNotMatch(env.actionProgressText(progress), /PRIVATE|SECRET/)
  assert.match(env.actionProgressText({ ...progress, state: 'waiting-entry' }), /等待入口 SSH/)
  for (const state of ['failed', 'cancelled']) assert.match(env.actionProgressText({ ...progress, state }), /后续动作已停止；不会自动重试/)
  assert.equal(env.actionProgressText({ ...progress, state: 'completed' }), '')
  assert.match(env.actionProgressText({ ...progress, state: 'completed', completed: 5, index: 5 }), /终端动作已完成 · 5\/5/)
  for (const bad of [{ state: 'unknown' }, { total: 33 }, { total: -1 }, { completed: 6 }, { index: 5 }, { index: 0.5 }]) assert.equal(env.actionProgressText({ ...progress, ...bad }), '')
  assert.doesNotMatch(env.actionProgressText({ ...progress, label: 'bad\u001blabel', type: 'PRIVATE INPUT' }), /label|PRIVATE/)
})

test('handoff only claims completion for consistent final progress', () => {
  const env = setup()
  const profile = { name: 'target', viaHost: 'entry', actions: allActions, actionProgress: { state: 'completed', total: 5, index: 1, completed: 1 } }
  assert.match(env.handoffMessage('target', 'entry:22', profile), /这不代表终端动作已完成/)
  assert.doesNotMatch(env.handoffMessage('target', 'entry:22', profile), /后端报告所有终端动作已完成/)
})

test('management selected-host progress reports fail-stop without raw contents or early online state', () => {
  const env = setup()
  const host = { name: 'target', viaHost: 'entry', actions: allActions, allowed: true }
  const progress = { state: 'failed', total: 5, index: 1, completed: 1, type: 'text', value: 'PRIVATE INPUT', output: 'PRIVATE OUTPUT' }
  env.setStates([{ hosts: [host], sessions: [], audit: [], terminal: { sessions: [{ host: 'target', state: 'connected', actionProgress: progress }] } }])
  const tree = env.render(env.RemoteOpsPage, {})
  const node = nodes(tree).find((node) => node.props['data-host-action-progress'] === 'failed')
  assert.equal(node.props.role, 'status')
  assert.match(text(tree), /后续动作已停止；不会自动重试/)
  assert.match(text(tree), /终端动作已停止/)
  assert.match(text(tree), /初始化未完成/)
  assert.doesNotMatch(text(tree), /PRIVATE INPUT|PRIVATE OUTPUT|终端在线/)
})

test('real terminal panel uses relay actionProgress but cannot announce connected early or reveal values', () => {
  const env = setup()
  const progress = { state: 'running', total: 2, index: 1, completed: 1, type: 'key', value: 'PRIVATE KEY', output: 'PRIVATE OUTPUT' }
  const overview = { hosts: [{ name: 'target', viaHost: 'entry', actions: allActions }], terminal: { sessions: [{ sessionKey: 's::target', sessionId: 's', host: 'target', state: 'connected', actionProgress: progress }] } }
  env.setStates([null, '', 0, true, overview])
  const tree = env.render(env.RemoteTerminalPanel, { sessionId: 's' })
  const node = nodes(tree).find((node) => node.props['data-terminal-action-progress'] === 'running')
  assert.equal(node.props.role, 'status')
  assert.equal(node.props['aria-live'], 'polite')
  assert.match(text(tree), /执行第 2\/2 步/)
  assert.match(text(tree), /初始化未完成/)
  assert.doesNotMatch(text(tree), /PRIVATE KEY|PRIVATE OUTPUT/)
})
