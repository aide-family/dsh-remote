import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const profile = { name: 'cluster-a', viaHost: 'bastion-demo', loginCommand: 'sww -r -u demo.user cluster-a', target: 'self@entrance:22', allowed: true, managed: true }
const entrance = { name: 'bastion-demo', target: 'self@entrance:22', allowed: true }

// Test the lazy browser module in isolation; no production test exports or DOM dependencies.
function setup() {
  let registration
  let cursor = 0
  let states = []
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useRef(value) { return { current: value } },
    useEffect() {},
    useCallback(fn) { return fn },
  }
  const instrumented = source.replace('    return plugin;', `    return {
    emptyHostForm, buildHostInput, HostFormModal, RemoteOpsPage, handoffMessage,
    terminalOnlyHost, connectionProfileLabel, PROFILE_NOTE, TERMINAL_ONLY_NOTE
  };`)
  assert.notEqual(source, instrumented)
  vm.runInNewContext(instrumented, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body))
      return { ok: true, json: async () => ({ ok: true, result: {} }) }
    },
  }, { timeout: 1000 })
  const api = registration.factory((name) => { assert.equal(name, 'react'); return React })
  return {
    ...api, calls,
    render(component, props = {}) { cursor = 0; return component(props) },
    setStates(values) { states = values },
  }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}
function field(tree, key) { return nodes(tree).find((node) => node.props?.['data-host-field'] === key) }
function text(tree) { return JSON.stringify(tree, (_key, value) => typeof value === 'function' ? undefined : value) }
const plain = (value) => JSON.parse(JSON.stringify(value))

test('canonical cluster profile preserves only safe lookup and login fields, never SSH auth or passwords', () => {
  const env = setup()
  const form = env.emptyHostForm(profile)
  assert.equal(form.connectionMode, 'cluster')
  assert.deepEqual(plain(form.actions), [{ type: 'command', value: profile.loginCommand, expectCluster: 'cluster-a' }])
  const input = env.buildHostInput({ ...form, password: 'do-not-save', passwordEnv: 'SECRET', host: 'stale.example', username: 'old', tags: 'prod, test', description: ' Cluster shortcut ' })
  assert.deepEqual(plain(input), { name: 'cluster-a', viaHost: 'bastion-demo', actions: [{ type: 'command', value: profile.loginCommand, expectCluster: 'cluster-a' }], tags: ['prod', 'test'], description: 'Cluster shortcut' })
})

test('ordinary SSH form and mode switch retain existing auth references without profile fields', () => {
  const env = setup()
  const form = env.emptyHostForm({ name: 'ssh-host', host: '10.0.0.1', port: 2222, username: 'ops', identityFile: '~/.ssh/id', passwordEnv: 'PASSWORD', proxyJump: ['jump'], tags: ['prod'] })
  assert.equal(form.connectionMode, 'ssh')
  assert.deepEqual(plain(env.buildHostInput({ ...form, viaHost: 'bastion-demo', loginUser: 'user', cluster: 'old' })), {
    name: 'ssh-host', host: '10.0.0.1', port: 2222, username: 'ops', identityFile: '~/.ssh/id', passwordEnv: 'PASSWORD', proxyJump: ['jump'], tags: ['prod'],
  })
  assert.throws(() => env.buildHostInput({ ...form, port: '65536' }), /端口/)
  assert.throws(() => env.buildHostInput({ ...form, host: '' }), /主机地址/)
})

for (const [key, value] of [
  ['viaHost', ''], ['viaHost', 'bastion-demo;id'], ['viaHost', 'cluster-a'],
  ['actions', [{ type: 'command', value: 'whoami\nid' }]],
  ['actions', [{ type: 'command', value: 'whoami', expectCluster: '$(id)' }]],
  ['actions', [{ type: 'command', value: 'whoami', expectCluster: '-bad' }]],
  ['actions', [{ type: 'command', value: 'whoami', expectCluster: 'a'.repeat(65) }]],
  ['actions', [{ type: 'text', value: 'hello', password: 'do-not-save' }]],
]) {
  test(`reject unsafe profile ${key}: ${JSON.stringify(value)}`, () => {
    const env = setup()
    assert.throws(() => env.buildHostInput({ ...env.emptyHostForm(profile), [key]: value }))
  })
}

test('cluster form offers ordinary entry hosts, saves canonical command, and explains PTY lifecycle', () => {
  const env = setup()
  let saved
  const props = { mode: 'edit', host: profile, hosts: [entrance, profile, { name: 'blocked', allowed: false }, { name: 'other-cluster', viaHost: 'bastion-demo' }], onSubmit(input) { saved = input } }
  let tree = env.render(env.HostFormModal, props)
  assert.equal(tree.props.trapFocus, true)
  const entries = nodes(field(tree, 'viaHost')).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(entries, ['', 'bastion-demo'])
  const actionValue = nodes(tree).find((node) => node.props?.['data-action-field'] === 'value')
  assert.equal(actionValue.props.required, true)
  assert.match(actionValue.props['aria-describedby'], /dshr-action-help/)
  assert.equal(field(tree, 'loginUser'), undefined)
  assert.equal(field(tree, 'cluster'), undefined)
  assert.equal(field(tree, 'host'), undefined)
  assert.equal(field(tree, 'passwordEnv'), undefined)
  assert.match(text(tree), /重新 attach.*不会重复动作/)
  assert.match(text(tree), /所有动作完成前不代表已就绪/)
  assert.match(text(tree), /Agent-owned PTY 不自动重连/)
  assert.match(text(tree), /无需审批（包括 sudo 切换用户）/)
  assert.match(text(tree), /Agent 后续发送的命令仍遵循审批策略/)
  assert.match(text(tree), /只读主机和命令禁止规则仍然生效/)
  actionValue.props.onChange({ target: { value: 'hostname' } })
  tree = env.render(env.HostFormModal, props)
  nodes(tree.props.footer).find((node) => node.props['data-host-form-action'] === 'save').props.onClick()
  assert.deepEqual(plain(saved.actions), [{ type: 'command', value: 'hostname', expectCluster: 'cluster-a' }])
  assert.equal(saved.loginCommand, undefined)
})

test('form mode switch exposes ordinary SSH and validation failure is announced without submitting', () => {
  const env = setup()
  let submitted = 0
  const props = { mode: 'create', hosts: [entrance], onSubmit() { submitted++ } }
  let tree = env.render(env.HostFormModal, props)
  assert.ok(field(tree, 'host'))
  field(tree, 'connectionMode').props.onChange({ target: { value: 'cluster' } })
  tree = env.render(env.HostFormModal, props)
  assert.ok(field(tree, 'viaHost'))
  nodes(tree.props.footer).find((node) => node.props['data-host-form-action'] === 'save').props.onClick()
  tree = env.render(env.HostFormModal, props)
  assert.equal(submitted, 0)
  const error = nodes(tree).find((node) => node.props['data-host-form-error'] === '')
  assert.equal(error.props.role, 'alert')
  assert.equal(nodes(tree).find((node) => node.props?.['data-action-field'] === 'value').props['aria-invalid'], 'true')
})

test('terminal-only profile disables probe with visible explanation and guards programmatic action', async () => {
  const env = setup()
  env.setStates([{ hosts: [profile], sessions: [], audit: [] }])
  const tree = env.render(env.RemoteOpsPage)
  const probe = nodes(tree).find((node) => node.props['data-host-action'] === 'test')
  assert.equal(probe.props.disabled, true)
  assert.match(probe.props.title, /exec\/SFTP/)
  assert.equal(probe.props['aria-describedby'], 'dshr-terminal-only-note')
  assert.ok(nodes(tree).find((node) => node.props.id === 'dshr-terminal-only-note'))
  await probe.props.onClick()
  assert.deepEqual(env.calls, [])
  assert.match(text(tree), /入口 bastion-demo → 1 步终端动作/)
  assert.doesNotMatch(text(tree), /sww -r -u/)
})

test('ordinary host probe remains enabled and invokes existing API', async () => {
  const env = setup()
  env.setStates([{ hosts: [entrance], sessions: [], audit: [] }])
  const tree = env.render(env.RemoteOpsPage)
  const probe = nodes(tree).find((node) => node.props['data-host-action'] === 'test')
  assert.equal(probe.props.disabled, false)
  await probe.props.onClick()
  assert.equal(env.calls[0].method, 'host.test')
  assert.equal(env.calls[0].name, 'bastion-demo')
})

test('profile handoff uses logical host, describes bootstrap and never claims silence proves login', () => {
  const env = setup()
  const message = env.handoffMessage('cluster-a', profile.target, profile)
  assert.match(message, /入口 host: bastion-demo/)
  assert.match(message, /1 步终端动作/)
  assert.doesNotMatch(message, /sww -r -u/)
  assert.match(message, /不代表终端动作已完成或已成功登录集群/)
  assert.match(message, /remote_shell_open（host: cluster-a）/)
  assert.match(message, /remote_exec/)
  assert.match(message, /请在终端核对登录位置/)
  const confirmed = env.handoffMessage('cluster-a', profile.target, { ...profile, actionProgress: { state: 'completed', total: 1, index: 1, completed: 1 } })
  assert.match(confirmed, /后端报告所有终端动作已完成/)
  assert.doesNotMatch(confirmed, /这不代表终端动作已完成/)
  assert.match(env.handoffMessage('bastion-demo', entrance.target), /^已连接远程主机 bastion-demo（/)
  assert.equal(env.terminalOnlyHost({ terminalOnly: true }), true)
  assert.equal(env.terminalOnlyHost(entrance), false)
})

test('terminal open retains profile lookup name and copy action still copies only relay launch command', () => {
  assert.match(source, /targetSessionId === null \? \{ name: name \} : \{ name: name, sessionId: targetSessionId \}/)
  assert.match(source, /copyTextToClipboard\(command, anchor\)/)
  assert.match(source, /connectionProfileLabel\(effectiveHostView\)/)
  assert.doesNotMatch(source, /copyTextToClipboard\([^\n]*loginCommand/)
})
