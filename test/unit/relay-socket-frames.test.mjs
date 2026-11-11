import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Expose only the real parser entry point; do not replace parser logic or open sockets.
const source = await readFile(new URL('../../lib/terminal/relay-socket.js', import.meta.url), 'utf8')
const instrumented = source.replace('  return {\n    start,', '  return {\n    onData,\n    start,')
assert.notEqual(instrumented, source)
const { createBridgeServer } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const handshake = JSON.stringify({ v: 1, host: 'fixture', sessionId: 'conversation' }) + '\n'
const input = (text) => JSON.stringify({ t: 'i', d: Buffer.from(text).toString('base64') }) + '\n'
const resize = JSON.stringify({ t: 'r', c: 100, r: 30 }) + '\n'
function setup({ missing = false, lookupError = false } = {}) {
  const entry = {}, inputs = [], sizes = [], output = []
  const server = createBridgeServer({ socketPath: '/fixture/not-opened.sock',
    findSession(host, sid) { assert.equal(host, 'fixture'); assert.equal(sid, 'conversation'); if (lookupError) throw new Error('lookup temporarily unavailable'); return missing ? null : entry },
    replayFor() { return 'replay' },
    onInput(_entry, text) { inputs.push(text) },
    onResize(_entry, cols, rows) { sizes.push([cols, rows]) },
  })
  const record = { buffer: '', handshakeDone: false, entry: null, closed: false, handshakeTimer: null,
    socket: { writable: true, write(text) { output.push(text) }, end(text) { if (text) output.push(text) }, destroy() {} },
  }
  return { server, record, inputs, sizes, output, feed(text) { server.onData(record, text) } }
}

const negotiated = JSON.stringify({ v: 1, host: 'fixture', sessionId: 'conversation', response: 'dsh-remote-handshake-v1', nonce: 'a'.repeat(24) }) + '\n'
function controlReply(env) { return JSON.parse(env.output[0].slice('\u001eDSHREMOTE/1 '.length)) }

test('negotiated acceptance precedes unchanged replay and retains coalesced input', () => {
  const env = setup()
  env.feed(negotiated + resize + input('hostname\r'))
  assert.equal(controlReply(env).status, 'accepted')
  assert.equal(env.output[1], 'replay')
  assert.deepEqual(env.inputs, ['hostname\r'])
  assert.deepEqual(env.sizes, [[100, 30]])
})

test('missing sessions are definitive but lookup exceptions remain retryable', () => {
  const missing = setup({ missing: true })
  missing.feed(negotiated)
  assert.equal(controlReply(missing).code, 'SESSION_GONE')
  assert.equal(controlReply(missing).retryable, false)
  const unavailable = setup({ lookupError: true })
  unavailable.feed(negotiated)
  assert.equal(controlReply(unavailable).code, 'LOOKUP_UNAVAILABLE')
  assert.equal(controlReply(unavailable).retryable, true)
})

test('legacy handshake receives only original raw replay or error banner', () => {
  const accepted = setup()
  accepted.feed(handshake)
  assert.deepEqual(accepted.output, ['replay'])
  const missing = setup({ missing: true })
  missing.feed(handshake)
  assert.equal(missing.output.join('').includes('DSHREMOTE/1'), false)
  assert.match(missing.output.join(''), /会话不存在或已关闭/)
})

test('handshake and coalesced resize/input frames are dispatched once in order', () => {
  const env = setup()
  env.feed(handshake + resize + input('hostname\r') + input('whoami\r'))
  assert.deepEqual(env.sizes, [[100, 30]])
  assert.deepEqual(env.inputs, ['hostname\r', 'whoami\r'])
  assert.equal(env.record.buffer, '')
})

test('partial input after handshake survives until the next chunk', () => {
  const env = setup()
  const frame = input('hostname\r')
  env.feed(handshake + frame.slice(0, 12))
  assert.equal(env.record.buffer, frame.slice(0, 12))
  assert.deepEqual(env.inputs, [])
  env.feed(frame.slice(12))
  assert.deepEqual(env.inputs, ['hostname\r'])
})

test('split handshake and later standalone input preserve normal dispatch', () => {
  const env = setup()
  env.feed(handshake.slice(0, 10))
  env.feed(handshake.slice(10))
  env.feed(input('hostname\r'))
  assert.deepEqual(env.inputs, ['hostname\r'])
})

test('malformed coalesced frame cannot erase a subsequent valid frame', () => {
  const env = setup()
  env.feed(handshake + '{broken}\n' + input('hostname\r'))
  assert.deepEqual(env.inputs, ['hostname\r'])
})
