import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
function setup({ frames = true, throws = false } = {}) {
  let registration, id = 0
  const timers = new Map(), paints = new Map(), cancelled = []
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key },
    clearTimeout(key) { timers.delete(key) },
    cancelAnimationFrame(key) { paints.delete(key); cancelled.push(key) },
  }
  if (frames) context.requestAnimationFrame = (fn) => {
    if (throws) throw new Error('renderer unavailable')
    const key = ++id; paints.set(key, fn); return key
  }
  vm.runInNewContext(source.replace('    return plugin;', '    return { nextPaint, terminalTabAlreadyOpen };'), context, { timeout: 1000 })
  const api = registration.factory(() => ({}))
  return { ...api, timers, paints, cancelled,
    paint() { const [key, fn] = paints.entries().next().value; paints.delete(key); fn() },
    timeout() { const [key, value] = timers.entries().next().value; timers.delete(key); value.fn() },
  }
}

test('Agent live events do not steal an existing interactive terminal tab', () => {
  const env = setup()
  const check = (tabs) => env.terminalTabAlreadyOpen({ tabsIn(id) { assert.equal(id, 'conversation'); return tabs } }, 'conversation')
  assert.equal(check([{ kind: 'terminal' }]), true)
  assert.equal(check([{ kind: 'dsh-remote-live' }]), true)
  assert.equal(check([null, { kind: 'files' }]), false)
  assert.equal(check([]), false)
})

test('normal paints settle after two frames and cancel the fallback timer', async () => {
  const env = setup()
  let done = false
  const pending = env.nextPaint().then(() => { done = true })
  env.paint()
  await Promise.resolve()
  assert.equal(done, false)
  env.paint()
  await pending
  assert.equal(done, true)
  assert.equal(env.timers.size, 0)
  assert.equal(env.paints.size, 0)
})

test('background renderer with no animation callbacks uses a bounded fallback', async () => {
  const env = setup()
  const pending = env.nextPaint()
  assert.equal([...env.timers.values()][0].ms, 250)
  env.timeout()
  await pending
  assert.equal(env.paints.size, 0)
  assert.equal(env.cancelled.length, 1)
})

test('suspension after first frame is also bounded and cancels the second frame', async () => {
  const env = setup()
  const pending = env.nextPaint()
  env.paint()
  env.timeout()
  await pending
  assert.equal(env.paints.size, 0)
})

test('missing animation API keeps the short timer fallback', async () => {
  const env = setup({ frames: false })
  const pending = env.nextPaint()
  assert.equal([...env.timers.values()][0].ms, 30)
  env.timeout()
  await pending
})

test('unavailable animation API cannot leave the terminal navigation pending', async () => {
  const env = setup({ throws: true })
  await env.nextPaint()
  assert.equal(env.timers.size, 0)
})
