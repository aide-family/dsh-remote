import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
test('covered progress modal releases keyboard/focus listeners and restores its original trigger after resume', () => {
  let registration, refCursor = 0, effectCursor = 0
  const refs = [], effects = [], pending = [], listeners = new Map(), focused = []
  const document = { activeElement: null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const trigger = { isConnected: true, focus() { focused.push('trigger'); document.activeElement = trigger } }
  const password = { isConnected: true, focus() { focused.push('password'); document.activeElement = password } }
  const button = { isConnected: true, focus() { focused.push('progress'); document.activeElement = button } }
  const dialog = { contains(node) { return node === dialog || node === button }, querySelectorAll() { return [button] }, focus() { button.focus() } }
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useRef(initial) { const index = refCursor++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index] },
    useEffect(fn, deps) {
      const index = effectCursor++, previous = effects[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push({ index, fn, deps, previous })
    },
  }
  vm.runInNewContext(source.replace('    return plugin;', '    return { ModalShell };'), { window: { __ModuleLoader__: { load(value) { registration = value } } }, document }, { timeout: 1000 })
  const { ModalShell } = registration.factory(() => React)
  const onClose = () => {}
  function render(suspended) {
    refCursor = 0; effectCursor = 0
    const tree = ModalShell({ title: 'progress', trapFocus: true, suspended, onClose })
    tree.children[0].props.ref.current = dialog
    for (const update of pending) update.previous?.cleanup?.()
    for (const update of pending.splice(0)) effects[update.index] = { deps: update.deps, cleanup: update.fn() }
  }
  trigger.focus(); render(false)
  assert.equal(document.activeElement, button)
  assert.equal(listeners.get('keydown').size, 2)
  render(true)
  assert.equal(listeners.get('keydown').size, 0)
  assert.equal(listeners.get('focusin').size, 0)
  assert.equal(focused.filter(name => name === 'trigger').length, 1, 'suspension must not restore outside focus')
  password.focus()
  render(false)
  assert.equal(document.activeElement, button)
  for (const effect of effects) effect.cleanup?.()
  assert.equal(document.activeElement, trigger, 'resume must not replace the original return target with password/progress')
  assert.equal(listeners.get('keydown').size, 0)
})
