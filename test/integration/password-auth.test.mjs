import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import ssh2 from 'ssh2'
import { createSshTransport } from '../../lib/ssh/transport.js'
import { resolveAuth } from '../../lib/ssh/auth.js'
import { loadSshConfig } from '../../lib/ssh-config.js'
import { loadHosts } from '../../lib/hosts.js'
import { createManagementApi } from '../../lib/api.js'
import { mapTerminalError } from '../../lib/api-helpers.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASSWORD = 'fixture-only-fixed-password'
async function startKeyboardServer(t, { prompts = [{ prompt: 'Password: ', echo: false }], rounds = 1 } = {}) {
  const clients = new Set()
  const attempts = []
  const responses = []
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      attempts.push(ctx.method)
      if (ctx.username !== 'fixture-user' || ctx.method !== 'keyboard-interactive') {
        ctx.reject(['keyboard-interactive'])
        return
      }
      let round = 0
      const challenge = () => ctx.prompt(prompts, (answers) => {
        responses.push(answers)
        round += 1
        if (answers.length !== 1 || answers[0] !== PASSWORD) return ctx.reject(['keyboard-interactive'])
        if (round < rounds) return challenge()
        ctx.accept()
      })
      challenge()
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('password-shell-ready\r\n')
        stream.on('data', (data) => stream.write(data))
      })
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const client of clients) client.end()
    await new Promise((resolve) => server.close(resolve))
  })
  const host = { id: 'fixture:password', name: 'password-box', host: '127.0.0.1',
    port: server.address().port, username: 'fixture-user', pubkeyAuthentication: false }
  return { host, attempts, responses }
}
function makeTransport(t, overrides = {}) {
  const logs = []
  const transport = createSshTransport({ connectTimeoutMs: 3000, idleMs: -1,
    knownHostsPolicy: 'insecure', env: {},
    logger: { debug(message) { logs.push(message) }, warn(message) { logs.push(message) } }, ...overrides })
  t.after(() => transport.dispose())
  return { transport, logs }
}

test('fixed password authenticates to keyboard-interactive-only server and opens a reused PTY', async (t) => {
  const { host, attempts, responses } = await startKeyboardServer(t)
  const { transport, logs } = makeTransport(t)
  assert.equal((await transport.test(host)).ok, false, 'no password must fail first')
  assert.deepEqual(await transport.authenticatePassword(host, PASSWORD), { authenticated: true, name: host.name })
  assert.equal((await transport.test(host)).ok, true)
  const pty = await transport.openPty(host)
  await pty.close()
  assert.equal(responses.length, 1, 'follow-up operations reuse authenticated connection')
  assert.deepEqual(responses[0], [PASSWORD])
  assert.ok(!attempts.includes('publickey'))
  assert.equal(logs.join('\n').includes(PASSWORD), false)
  assert.equal(JSON.stringify(host).includes(PASSWORD), false)
  assert.equal(transport.poolSize, 1)
  const otherUser = { ...host, username: 'someone-else' }
  const other = await transport.test(otherUser)
  assert.equal(other.ok, false, 'credentials must not transfer to another username')
  transport.dispose()
  assert.equal(transport.poolSize, 0)
})

test('PasswordAuthentication no still allows explicitly enabled keyboard-interactive', async (t) => {
  const { host, attempts } = await startKeyboardServer(t)
  host.passwordAuthentication = false
  host.keyboardInteractiveAuthentication = true
  const { transport } = makeTransport(t)
  await transport.authenticatePassword(host, PASSWORD)
  assert.equal((await transport.test(host)).ok, true)
  assert.ok(!attempts.includes('password'))
})

test('cancelled password login does not connect or cache a credential', async (t) => {
  const { host, attempts } = await startKeyboardServer(t)
  const { transport } = makeTransport(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(transport.authenticatePassword(host, PASSWORD, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(attempts.length, 0)
  assert.equal(transport.poolSize, 0)
  assert.equal((await transport.test(host)).ok, false)
})

test('wrong fixed password is never cached', async (t) => {
  const { host, responses } = await startKeyboardServer(t)
  const { transport } = makeTransport(t)
  await assert.rejects(transport.authenticatePassword(host, 'wrong-fixture-password'), { code: 'AUTH' })
  const responseCount = responses.length
  assert.equal((await transport.test(host)).ok, false)
  assert.equal(responses.length, responseCount, 'a failed password must not be retried on the next operation')
})

for (const [label, options] of [
  ['OTP prompt', { prompts: [{ prompt: 'Verification code: ', echo: false }] }],
  ['multiple prompts', { prompts: [{ prompt: 'Password: ', echo: false }, { prompt: 'OTP: ', echo: false }] }],
  ['echoing prompt', { prompts: [{ prompt: 'Password: ', echo: true }] }],
  ['second round', { rounds: 2 }],
]) {
  test(`fixed password is not disclosed to ${label}`, async (t) => {
    const { host, responses } = await startKeyboardServer(t, options)
    const { transport } = makeTransport(t)
    await assert.rejects(transport.authenticatePassword(host, PASSWORD), { code: 'AUTH' })
    const relevant = label === 'second round' ? responses.slice(1) : responses
    assert.ok(relevant.length > 0)
    assert.ok(relevant.every((answers) => answers.length === 0))
  })
}

test('PubkeyAuthentication no bypasses all private-key reads and propagates from SSH config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-password-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'config')
  await writeFile(file, 'Host password-box\n  HostName 127.0.0.1\n  User fixture-user\n  PubkeyAuthentication no\n  PasswordAuthentication no\n  KbdInteractiveAuthentication yes\n')
  const record = loadSshConfig(file)[0]
  assert.equal(record.pubkeyAuthentication, false)
  assert.equal(record.passwordAuthentication, false)
  assert.equal(record.keyboardInteractiveAuthentication, true)
  const hosts = await loadHosts({ includeSshConfig: true, sshConfigPath: file, hosts: [] })
  assert.equal(hosts[0].pubkeyAuthentication, false)
  const auth = await resolveAuth({ ...record, identityFile: '/must-not-be-read' }, {
    env: { SSH_AUTH_SOCK: '/also-not-read' }, fs: { readFile() { assert.fail('private key read') }, stat() { assert.fail('agent stat') } },
  })
  assert.equal(auth.method, 'none')
})

test('password API is fenced, allowlisted, non-persisting and redacts server-controlled errors', async (t) => {
  const host = { id: 'test', name: 'box', host: '127.0.0.1' }
  const calls = []
  const audit = []
  let allowed = true
  let error
  const handler = createManagementApi({
    ctx: { get(name) { return name === 'connection' ? { requestRejection(req) { return req.headers['x-test-auth'] === 'yes' ? undefined : 'forbidden' } } : undefined } },
    config: {}, hosts: { async find(name) { return name === host.name ? host : undefined }, isAllowed() { return allowed } },
    audit: { record(value) { audit.push(value) } },
    transport: { async authenticatePassword(found, password) { calls.push([found.name, password]); if (error) throw error } },
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const request = async (body, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-remote/api`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-test-auth': 'yes' } : {}) }, body: JSON.stringify(body),
    })
    return response.json()
  }
  const body = { method: 'auth.password', name: host.name, password: PASSWORD }
  assert.equal((await request(body, false)).ok, false)
  assert.equal(calls.length, 0)
  allowed = false
  assert.equal((await request(body)).error.code, 'HOST_DISALLOWED')
  assert.equal(calls.length, 0)
  allowed = true
  assert.deepEqual((await request(body)).result, { authenticated: true, name: 'box' })
  assert.equal((await request({ ...body, password: '' })).error.code, 'INVALID_ARGUMENT')
  error = Object.assign(new Error(`server echoed ${PASSWORD}`), { code: 'AUTH' })
  const failed = await request(body)
  assert.equal(failed.error.code, 'AUTH')
  assert.equal(JSON.stringify(failed).includes(PASSWORD), false)
  assert.deepEqual(audit, [])
  const mapped = mapTerminalError(error)
  assert.equal(mapped.code, 'AUTH')
  assert.equal(mapped.message.includes(PASSWORD), false)
})
