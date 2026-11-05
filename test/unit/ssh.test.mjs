/**
 * Unit/integration tests for lib/ssh/** against the real ssh2 fixture server
 * (test/fixtures/ssh-server.mjs). Covers auth resolution, exec semantics,
 * timeouts/aborts/truncation, SFTP primitives, pooling/serialization/retry,
 * ProxyJump, homeDir and the known-hosts policies end to end.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

import { startSshServer } from '../fixtures/ssh-server.mjs'
import { createSshTransport } from '../../lib/ssh/transport.js'
import { runExec } from '../../lib/ssh/exec.js'
import { isChannelFailure, RemoteFsError, SshError } from '../../lib/ssh/errors.js'
import { resolveAuth, DEFAULT_KEY_NAMES } from '../../lib/ssh/auth.js'
import { knownHostId } from '../../lib/ssh/known-hosts.js'

const { utils } = ssh2

const CONNECT_TIMEOUT_MS = 5_000

/**
 * Generate a key pair ssh2 can actually parse (ssh2 1.17.0 occasionally emits a
 * malformed OpenSSH ed25519 private key, so retry until both halves parse).
 *
 * @param {'ed25519'|'ecdsa'} type
 * @param {object} [options]
 */
function generateUsableKeyPair(type, options = {}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair = utils.generateKeyPairSync(type, options)
    try {
      const privateKey = utils.parseKey(pair.private, options?.passphrase)
      const publicKey = utils.parseKey(pair.public)
      if (
        privateKey &&
        typeof privateKey.getPublicSSH === 'function' &&
        publicKey &&
        typeof publicKey.getPublicSSH === 'function'
      ) {
        return pair
      }
    } catch {
      // retry a malformed pair
    }
  }
  throw new Error(`could not generate a usable ${type} key pair`)
}
/** @type {Set<string>} */
const tempDirs = new Set()

test.after(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** @param {string} prefix */
async function makeTempDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until `predicate()` returns true (or timeout). Returns the last value.
 *
 * @param {() => boolean|Promise<boolean>} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 4_000) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - startedAt >= timeoutMs) return false
    await delay(25)
  }
}

/**
 * Boot a fixture server + a transport wired to it.
 *
 * @param {object} [options]
 * @param {object} [options.serverOptions]
 * @param {object} [options.transportOptions]
 * @param {object} [options.env]
 * @param {object} [options.hostOverrides]
 */
async function setup(options = {}) {
  const srv = await startSshServer(options.serverOptions ?? {})
  const env = { TEST_SSH_PASSWORD: srv.password, USER: 'fixture-user', ...(options.env ?? {}) }
  const transport = createSshTransport({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    knownHostsPolicy: 'insecure',
    env,
    ...(options.transportOptions ?? {}),
  })
  const host = {
    id: `fixture-${srv.port}`,
    name: 'fixture',
    host: srv.host,
    port: srv.port,
    username: srv.username,
    passwordEnv: 'TEST_SSH_PASSWORD',
    ...(options.hostOverrides ?? {}),
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    transport.dispose()
    await srv.close()
  }
  return { srv, transport, host, env, close }
}

/* ================================================================== */
/* error classification                                               */
/* ================================================================== */

test('errors: isChannelFailure retries only channel-level failures, never path errors', () => {
  // Explicit mapper decisions win, even when the message looks retryable.
  assert.equal(isChannelFailure(new SshError('connection lost after exit', 'CONNECT', { channelFailure: false })), false)
  assert.equal(isChannelFailure(new SshError('channel open failure', 'CONNECT', { channelFailure: true })), true)
  assert.equal(isChannelFailure(new RemoteFsError('connection lost', 'CONNECTION')), true)
  assert.equal(isChannelFailure(new RemoteFsError('no such file', 'ENOENT')), false)
  assert.equal(isChannelFailure(new RemoteFsError('permission denied', 'EACCES')), false)
  // Raw (unmapped) errors from a withSftp callback use message heuristics.
  assert.equal(isChannelFailure(new Error('Channel open failure')), true)
  assert.equal(isChannelFailure(new Error('Permission denied')), false)
  assert.equal(isChannelFailure(null), false)
})

/* ================================================================== */
/* probe / auth                                                       */
/* ================================================================== */

test('probe: password auth connects, reports latency and reuses the pooled connection', async (t) => {
  const { srv, transport, host, close } = await setup({ serverOptions: { banner: 'fixture-banner' } })
  t.after(close)

  const first = await transport.test(host)
  assert.equal(first.ok, true)
  assert.equal(typeof first.latencyMs, 'number')
  assert.ok(first.latencyMs >= 0)
  // insecure policy surfaces its warning on the probe result
  assert.match(first.warning ?? '', /insecure/i)

  const second = await transport.test(host)
  assert.equal(second.ok, true)
  assert.equal(srv.connectionTotal, 1, 'probe must reuse the pooled connection')
})

test('probe: connection refused is reported as { ok: false } with SshError CONNECT (never throws)', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  await srv.close()

  const probe = await transport.test(host)
  assert.equal(probe.ok, false)
  assert.ok(probe.error instanceof SshError)
  assert.equal(probe.error.code, 'CONNECT')
})

test('auth: wrong password → SshError AUTH without leaking the secret', async (t) => {
  const secret = 'super-secret-password-value'
  const { transport, host, close } = await setup({ env: { TEST_SSH_PASSWORD: secret } })
  t.after(close)

  const probe = await transport.test(host)
  assert.equal(probe.ok, false)
  assert.ok(probe.error instanceof SshError)
  assert.equal(probe.error.code, 'AUTH')
  assert.equal(probe.error.message.includes(secret), false, 'password must never appear in errors')
})

test('auth: generated ed25519 identity file authenticates', async (t) => {
  const { srv, transport, host, close } = await setup({
    hostOverrides: { passwordEnv: undefined, identityFile: undefined },
  })
  t.after(close)
  // The fixture exposes its generated client key; use it explicitly.
  const keyHost = { ...host, identityFile: srv.privateKeyPath }
  const probe = await transport.test(keyHost)
  assert.equal(probe.ok, true)

  const result = await transport.exec(keyHost, { command: 'printf key-auth-ok' })
  assert.equal(result.stdout, 'key-auth-ok')
})

test('auth: passphrase-protected identity works; wrong passphrase → SshError AUTH', async (t) => {
  const keyPair = generateUsableKeyPair('ecdsa', { bits: 256, passphrase: 'pp-secret', cipher: 'aes256-ctr' })
  const dir = await makeTempDir('dsh-remote-key-')
  const keyPath = path.join(dir, 'id_ecdsa')
  await fsp.writeFile(keyPath, keyPair.private, { mode: 0o600 })

  const { srv, transport, host, close } = await setup({
    serverOptions: { authorizedKeys: [keyPair.public] },
    env: { KEY_PASSPHRASE: 'pp-secret' },
    hostOverrides: { passwordEnv: undefined, identityFile: keyPath, passphraseEnv: 'KEY_PASSPHRASE' },
  })
  t.after(close)
  const probe = await transport.test(host)
  assert.equal(probe.ok, true)

  const wrongTransport = createSshTransport({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    knownHostsPolicy: 'insecure',
    env: { KEY_PASSPHRASE: 'not-the-passphrase', USER: 'fixture-user' },
  })
  t.after(() => wrongTransport.dispose())
  const wrongHost = { ...host, id: `wrong-pass-${srv.port}` }
  const denied = await wrongTransport.test(wrongHost)
  assert.equal(denied.ok, false)
  assert.ok(denied.error instanceof SshError)
  assert.equal(denied.error.code, 'AUTH')
  assert.equal(denied.error.message.includes('not-the-passphrase'), false)
})

test('auth: default keys are used when ~/.ssh has no explicit identity', async (t) => {
  const keyPair = generateUsableKeyPair('ed25519')
  const fakeHome = await makeTempDir('dsh-remote-home-')
  await fsp.mkdir(path.join(fakeHome, '.ssh'), { recursive: true })
  await fsp.writeFile(path.join(fakeHome, '.ssh', 'id_ed25519'), keyPair.private, { mode: 0o600 })

  const { srv, transport, host, close } = await setup({
    serverOptions: { authorizedKeys: [keyPair.public] },
    env: {},
    transportOptions: { env: {}, homeDir: fakeHome },
    hostOverrides: { passwordEnv: undefined },
  })
  t.after(close)
  const probe = await transport.test(host)
  assert.equal(probe.ok, true, `default key should authenticate: ${probe.error?.message ?? ''}`)
  assert.equal(srv.connectionTotal, 1)
})

test('auth: resolveAuth order is passwordEnv → identityFile → agent → default keys', async (t) => {
  const dir = await makeTempDir('dsh-remote-auth-')
  const keyPath = path.join(dir, 'id_test')
  await fsp.writeFile(keyPath, 'PRIVATE-KEY-CONTENT', { mode: 0o600 })

  // 1. passwordEnv wins over identityFile
  const password = await resolveAuth(
    { host: 'h', username: 'u', passwordEnv: 'PW', identityFile: keyPath },
    { env: { PW: 'secret-pass' }, homeDir: dir, fs: fsp },
  )
  assert.equal(password.method, 'password')
  assert.equal(password.password, 'secret-pass')
  assert.equal(password.username, 'u')
  assert.equal(password.fingerprint.includes('secret-pass'), false)

  // 2. empty password env falls through to the identity file (+ passphrase)
  const key = await resolveAuth(
    { host: 'h', username: 'u', passwordEnv: 'PW', identityFile: keyPath, passphraseEnv: 'PP' },
    { env: { PW: '', PP: 'pp-secret' }, homeDir: dir, fs: fsp },
  )
  assert.equal(key.method, 'key')
  assert.equal(key.identityFile, keyPath)
  assert.equal(key.privateKey.toString(), 'PRIVATE-KEY-CONTENT')
  assert.equal(key.passphrase, 'pp-secret')
  assert.equal(key.fingerprint.includes('PRIVATE-KEY-CONTENT'), false)
  assert.equal(key.fingerprint.includes('pp-secret'), false)

  // 3. agent when SSH_AUTH_SOCK exists (any existing filesystem node)
  const agentPath = path.join(dir, 'agent.sock')
  await fsp.writeFile(agentPath, '')
  const agent = await resolveAuth(
    { host: 'h', username: 'u' },
    { env: { SSH_AUTH_SOCK: agentPath }, homeDir: path.join(dir, 'missing-home'), fs: fsp },
  )
  assert.equal(agent.method, 'agent')
  assert.equal(agent.agent, agentPath)

  // 3b. a missing agent socket falls through
  const noAgent = await resolveAuth(
    { host: 'h', username: 'u' },
    { env: { SSH_AUTH_SOCK: path.join(dir, 'missing.sock') }, homeDir: path.join(dir, 'missing-home'), fs: fsp },
  )
  assert.equal(noAgent.method, 'none')

  // 4. default keys in order ~/.ssh/id_ed25519, id_ecdsa, id_rsa
  assert.deepEqual([...DEFAULT_KEY_NAMES], ['id_ed25519', 'id_ecdsa', 'id_rsa'])
  const fakeHome = path.join(dir, 'home')
  await fsp.mkdir(path.join(fakeHome, '.ssh'), { recursive: true })
  await fsp.writeFile(path.join(fakeHome, '.ssh', 'id_rsa'), 'DEFAULT-RSA')
  const fallback = await resolveAuth({ host: 'h', username: 'u' }, { env: {}, homeDir: fakeHome, fs: fsp })
  assert.equal(fallback.method, 'default-key')
  assert.match(fallback.identityFile, /\.ssh\/id_rsa$/)

  // 5. no credentials: method "none", let the server reject
  const none = await resolveAuth({ host: 'h', username: 'u' }, { env: {}, homeDir: path.join(dir, 'nohome'), fs: fsp })
  assert.equal(none.method, 'none')
})

test('auth: unreadable identity file is a clear SshError (no secret in message)', async () => {
  const missing = path.join(os.tmpdir(), 'dsh-remote-does-not-exist', 'id_ed25519')
  await assert.rejects(
    resolveAuth({ host: 'h', identityFile: missing }, { env: {}, homeDir: os.tmpdir(), fs: fsp }),
    (error) => error instanceof SshError && error.code === 'CONNECT' && error.message.includes(missing),
  )
})

/* ================================================================== */
/* exec                                                               */
/* ================================================================== */

test('exec: stdout/stderr/exit code; non-zero exit is a normal result', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  const result = await transport.exec(host, {
    command: "printf 'out-line\\n'; printf 'err-line\\n' 1>&2; exit 42",
  })
  assert.equal(result.code, 42)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, 'out-line\n')
  assert.equal(result.stderr, 'err-line\n')
  assert.equal(result.stdoutBytes, 'out-line\n'.length)
  assert.equal(result.stderrBytes, 'err-line\n'.length)
  assert.equal(result.truncated, false)
  assert.equal(result.timedOut, false)
  assert.ok(result.durationMs >= 0)

  const zero = await transport.exec(host, { command: 'true' })
  assert.equal(zero.code, 0)
  assert.equal(zero.stdout, '')
})

test('exec: workdir is applied as `cd <quoted>`', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const workdir = path.join(srv.rootDir, 'dir with spaces')
  await fsp.mkdir(workdir, { recursive: true })

  const result = await transport.exec(host, { command: 'pwd', workdir })
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), workdir)
  const recorded = srv.execCommands.at(-1)
  assert.equal(recorded, `cd '${workdir}' && pwd`)
})

test('exec: timeout resolves with timedOut, code -1 and partial output', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  const startedAt = Date.now()
  const result = await transport.exec(host, { command: 'printf start; sleep 5; printf end', timeoutMs: 300 })
  const elapsed = Date.now() - startedAt
  assert.equal(result.timedOut, true)
  assert.equal(result.code, -1)
  assert.equal(result.stdout, 'start')
  assert.equal(result.stdout.includes('end'), false)
  assert.ok(elapsed < 3_000, `timeout should settle promptly (took ${elapsed}ms)`)

  // The transport (and the fixture) survive the killed channel.
  const after = await transport.exec(host, { command: 'printf still-alive' })
  assert.equal(after.stdout, 'still-alive')
})

test('exec: AbortSignal rejects with AbortError and closes the channel', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const controller = new AbortController()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(
    transport.exec(host, { command: 'sleep 5', signal: controller.signal, timeoutMs: 10_000 }),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.ok(Date.now() - startedAt < 3_000)

  // Channels/connection still usable after the abort.
  const result = await transport.exec(host, { command: 'printf after-abort' })
  assert.equal(result.stdout, 'after-abort')
  assert.equal(srv.connectionTotal, 1, 'the abort must not kill the pooled connection')

  // An already-aborted signal rejects before doing any work.
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    transport.exec(host, { command: 'printf never', signal: preAborted.signal }),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
})

/**
 * Fake ssh2 client whose channel emits `close` synchronously from its own
 * teardown and never reports an exit status: the shape that races with the
 * abort/timeout settlement path. No server, so the race is deterministic.
 */
function teardownClosingClient() {
  return {
    exec(_command, callback) {
      /** @type {null | (() => void)} */
      let onClose = null
      const channel = {
        stderr: { on() {} },
        on(event, listener) {
          if (event === 'close') onClose = listener
          return this
        },
        signal() {},
        close() {
          onClose?.()
        },
        destroy() {},
      }
      callback(null, channel)
    },
  }
}

test('exec: teardown close during an abort is not a channel failure', async () => {
  const controller = new AbortController()
  const promise = runExec(teardownClosingClient(), 'sleep 5', {
    signal: controller.signal,
    timeoutMs: 10_000,
  })
  controller.abort()
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(
      isChannelFailure(error),
      false,
      'an abort must never look like a retryable channel failure',
    )
    return true
  })
})

test('exec: teardown close on timeout still resolves with timedOut', async () => {
  const result = await runExec(teardownClosingClient(), 'sleep 5', { timeoutMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, -1)
})

test('exec: maxBytes keeps the tail of each stream and flags truncation', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  const command = "awk 'BEGIN{for(i=0;i<5000;i++) printf \"line-%05d\\n\", i}'"
  const result = await transport.exec(host, { command, maxBytes: 1_000 })
  assert.equal(result.truncated, true)
  assert.equal(result.stdoutBytes, 55_000)
  assert.equal(result.stdout.length, 1_000)
  assert.match(result.stdout, /line-04999\n$/, 'the tail must be kept')
  assert.doesNotMatch(result.stdout.slice(0, 100), /line-00000/)

  const stderrResult = await transport.exec(host, {
    command: "awk 'BEGIN{for(i=0;i<200;i++) printf \"err-%05d\\n\", i > \"/dev/stderr\"}'",
    maxBytes: 64,
  })
  assert.equal(stderrResult.truncated, true)
  assert.equal(stderrResult.stderr.length, 64)
  assert.match(stderrResult.stderr, /err-00199\n$/)
})

test('exec: pty option is accepted and runs the command', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)
  const result = await transport.exec(host, { command: 'printf pty-ok', pty: true })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /pty-ok/)
})

test('exec: channel-level failure retries once on a fresh connection', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const warmup = await transport.exec(host, { command: 'printf warmup' })
  assert.equal(warmup.stdout, 'warmup')
  assert.equal(srv.connectionTotal, 1)

  srv.failNextExec()
  const result = await transport.exec(host, { command: 'printf retried' })
  assert.equal(result.stdout, 'retried')
  assert.equal(srv.connectionTotal, 2, 'the failed channel must be retried on exactly one fresh connection')
})

/* ================================================================== */
/* pooling / serialization                                            */
/* ================================================================== */

test('pool: sequential execs reuse one connection; concurrent execs are serialized per host', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  for (const expected of ['one', 'two', 'three']) {
    const result = await transport.exec(host, { command: `printf ${expected}` })
    assert.equal(result.stdout, expected)
  }
  assert.equal(srv.connectionTotal, 1, 'sequential operations must share the pooled connection')

  const startedAt = Date.now()
  const [a, b] = await Promise.all([
    transport.exec(host, { command: 'sleep 0.2; printf a' }),
    transport.exec(host, { command: 'sleep 0.2; printf b' }),
  ])
  const elapsed = Date.now() - startedAt
  assert.equal(a.stdout, 'a')
  assert.equal(b.stdout, 'b')
  assert.ok(elapsed >= 320, `per-host operations must serialize (took ${elapsed}ms for 2×200ms)`)
  assert.equal(srv.connectionTotal, 1)
})

test('pool: idle connections are closed after idleMs and reopened on demand', async (t) => {
  const { srv, transport, host, close } = await setup({ transportOptions: { idleMs: 100 } })
  t.after(close)

  await transport.exec(host, { command: 'printf idle' })
  assert.equal(srv.connectionCount, 1)
  const closed = await waitFor(() => srv.connectionCount === 0)
  assert.equal(closed, true, 'idle pooled connection should close')

  const reopened = await transport.exec(host, { command: 'printf reopened' })
  assert.equal(reopened.stdout, 'reopened')
  assert.equal(srv.connectionTotal, 2)
})

test('dispose: idempotent, closes pooled connections, later operations reject', async (t) => {
  const { srv, transport, host } = await setup()
  t.after(() => srv.close())
  await transport.exec(host, { command: 'printf bye' })
  assert.equal(srv.connectionCount, 1)

  transport.dispose()
  transport.dispose()
  assert.equal(transport.isDisposed, true)
  const closed = await waitFor(() => srv.connectionCount === 0)
  assert.equal(closed, true)
  await assert.rejects(
    transport.exec(host, { command: 'printf nope' }),
    (error) => error instanceof SshError && error.code === 'CONNECT' && /disposed/.test(error.message),
  )
})

/* ================================================================== */
/* SFTP                                                               */
/* ================================================================== */

test('sftp: writeFile/readFile round-trip is atomic (temp + rename, no leftovers)', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const content = Buffer.alloc(200_000, 'a').toString('utf8')
  const target = `${srv.rootDir}/nested/dir/file.txt`
  const write = await transport.writeFile(host, target, content, { createDirs: true, mode: 0o640 })
  assert.equal(write.bytesWritten, content.length)

  const localEntries = await fsp.readdir(`${srv.rootDir}/nested/dir`)
  assert.deepEqual(localEntries, ['file.txt'], 'no temp file may be left behind')

  const read = await transport.readFile(host, target, { maxBytes: 800_000 })
  assert.equal(read.content.toString('utf8'), content)
  assert.equal(read.size, content.length)
  assert.equal(read.truncated, false)

  const stat = await transport.stat(host, target)
  assert.equal(stat.type, 'file')
  assert.equal(stat.mode & 0o777, 0o640)

  // Overwrite atomically through an existing file.
  const overwrite = await transport.writeFile(host, target, 'second version')
  assert.equal(overwrite.bytesWritten, 'second version'.length)
  assert.deepEqual(await fsp.readdir(`${srv.rootDir}/nested/dir`), ['file.txt'])
  assert.equal((await fsp.readFile(target, 'utf8')), 'second version')
})

test('sftp: readFile caps at maxBytes and reports truncation/size', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const target = `${srv.rootDir}/big.txt`
  const content = '0123456789'.repeat(500) // 5000 bytes
  await fsp.writeFile(target, content)

  const partial = await transport.readFile(host, target, { maxBytes: 1_000 })
  assert.equal(partial.content.length, 1_000)
  assert.equal(partial.content.toString(), content.slice(0, 1_000))
  assert.equal(partial.size, 5_000)
  assert.equal(partial.truncated, true)

  const empty = await transport.readFile(host, target, { maxBytes: 0 })
  assert.equal(empty.content.length, 0)
  assert.equal(empty.truncated, true)
})

test('sftp: stat reports file/dir/symlink(+target), and ENOENT/ENOTDIR mapping', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const filePath = `${srv.rootDir}/stat-file.txt`
  const dirPath = `${srv.rootDir}/stat-dir`
  const linkPath = `${srv.rootDir}/stat-link`
  await fsp.writeFile(filePath, 'abcdef')
  await fsp.mkdir(dirPath)
  await fsp.symlink(filePath, linkPath)

  const fileStat = await transport.stat(host, filePath)
  assert.equal(fileStat.type, 'file')
  assert.equal(fileStat.size, 6)
  assert.equal(typeof fileStat.mode, 'number')
  assert.match(fileStat.modeString, /^-rw/)
  assert.ok(fileStat.mtimeMs > 0)

  const dirStat = await transport.stat(host, dirPath)
  assert.equal(dirStat.type, 'dir')
  assert.match(dirStat.modeString, /^d/)

  const linkStat = await transport.stat(host, linkPath)
  assert.equal(linkStat.type, 'symlink')
  assert.equal(linkStat.target, filePath)

  await assert.rejects(
    transport.stat(host, `${srv.rootDir}/missing-file`),
    (error) => error instanceof RemoteFsError && error.code === 'ENOENT' && /sftp code=2/.test(error.message),
  )
  await assert.rejects(
    transport.stat(host, `${filePath}/child`),
    (error) => error instanceof RemoteFsError && error.code === 'ENOTDIR',
  )
  await assert.rejects(
    transport.readFile(host, `${srv.rootDir}/missing-file`),
    (error) => error instanceof RemoteFsError && error.code === 'ENOENT' && error.path !== undefined,
  )
  await assert.rejects(
    transport.listDir(host, `${srv.rootDir}/missing-dir`),
    (error) => error instanceof RemoteFsError && error.code === 'ENOENT',
  )
  // Reading/writing a directory is reported explicitly.
  await assert.rejects(
    transport.readFile(host, dirPath),
    (error) => error instanceof RemoteFsError && error.code === 'EISDIR',
  )
  // writeFile into a missing directory is ENOENT unless createDirs is set.
  await assert.rejects(
    transport.writeFile(host, `${srv.rootDir}/no-such-dir/x.txt`, 'x'),
    (error) => error instanceof RemoteFsError && error.code === 'ENOENT',
  )
})

test('sftp: listDir returns sorted entries with types and skips . / ..', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const dir = `${srv.rootDir}/listing`
  await fsp.mkdir(dir)
  await fsp.writeFile(`${dir}/b.txt`, 'bbb')
  await fsp.writeFile(`${dir}/a.txt`, 'a')
  await fsp.mkdir(`${dir}/c-sub`)
  await fsp.symlink(`${dir}/a.txt`, `${dir}/d-link`)

  // More entries than one SFTP READDIR packet so client/server chunking is exercised.
  for (let i = 0; i < 70; i += 1) {
    await fsp.writeFile(`${dir}/many-${String(i).padStart(2, '0')}.txt`, String(i))
  }

  const entries = await transport.listDir(host, dir)
  assert.equal(entries.length, 74, 'all directory entries must be returned (paged READDIR)')
  assert.deepEqual(
    entries.slice(0, 4).map((entry) => entry.name),
    ['a.txt', 'b.txt', 'c-sub', 'd-link'],
  )
  assert.equal(entries.at(-1).name, 'many-69.txt')
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('a.txt').type, 'file')
  assert.equal(byName.get('a.txt').size, 1)
  assert.equal(byName.get('c-sub').type, 'dir')
  assert.equal(byName.get('d-link').type, 'symlink')
})

test('sftp: mkdirp creates nested directories and is idempotent', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const target = `${srv.rootDir}/a/b/c/d`
  await transport.mkdirp(host, target)
  assert.equal((await fsp.stat(target)).isDirectory(), true)
  await transport.mkdirp(host, target) // no error on second call
  await transport.mkdirp(host, `${target}/`)
  assert.equal((await transport.stat(host, target)).type, 'dir')
})

test('sftp: chmod updates the permission bits', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const target = `${srv.rootDir}/chmod.txt`
  await transport.writeFile(host, target, 'x', { mode: 0o644 })

  await transport.chmod(host, target, 0o600)
  assert.equal((await transport.stat(host, target)).mode & 0o777, 0o600)

  await transport.chmod(host, target, 0o755)
  assert.equal((await transport.stat(host, target)).mode & 0o777, 0o755)
})

test('sftp: permission denied maps to RemoteFsError EACCES', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const dir = `${srv.rootDir}/readonly-dir`
  await transport.mkdirp(host, dir)
  await transport.chmod(host, dir, 0o555)
  try {
    await assert.rejects(
      transport.writeFile(host, `${dir}/nope.txt`, 'data'),
      (error) => error instanceof RemoteFsError && error.code === 'EACCES',
    )
  } finally {
    await transport.chmod(host, dir, 0o755)
  }
})

test('sftp: withSftp provides a dedicated channel, passes the host, and serializes', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const realpath = await transport.withSftp(host, async (sftp, passedHost) => {
    assert.equal(passedHost, host)
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (error, resolved) => (error ? reject(error) : resolve(resolved)))
    })
  })
  assert.equal(realpath, srv.rootDir)

  const startedAt = Date.now()
  const results = await Promise.all([
    transport.withSftp(host, async () => {
      await delay(150)
      return 'first'
    }),
    transport.withSftp(host, async () => {
      await delay(150)
      return 'second'
    }),
  ])
  const elapsed = Date.now() - startedAt
  assert.deepEqual(results, ['first', 'second'])
  assert.ok(elapsed >= 250, `withSftp must serialize per host (took ${elapsed}ms)`)
  assert.equal(srv.connectionTotal, 1)
})

test('sftp: homeDir resolves via REALPATH "." and is cached per connection', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  const home = await transport.homeDir(host)
  assert.equal(home, srv.rootDir)

  const again = await transport.homeDir(host)
  assert.equal(again, home)
  assert.equal(srv.connectionTotal, 1, 'homeDir must be cached on the pooled connection')

  // ~-style paths built from homeDir work for read/write.
  await transport.writeFile(host, `${home}/dot-home.txt`, 'tilde')
  assert.equal((await transport.readFile(host, `${home}/dot-home.txt`)).content.toString(), 'tilde')
})

test('sftp: homeDir also works over publickey auth', async (t) => {
  const { srv, transport, host, close } = await setup({
    hostOverrides: { passwordEnv: undefined },
  })
  t.after(close)
  const keyHost = { ...host, identityFile: srv.privateKeyPath }
  assert.equal(await transport.homeDir(keyHost), srv.rootDir)
})

/* ================================================================== */
/* known-hosts transport integration                                  */
/* ================================================================== */

test('known-hosts: tofu persists the fixture key, strict accepts it, insecure warns', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)
  const khDir = await makeTempDir('dsh-remote-transport-kh-')
  const khPath = path.join(khDir, 'known-hosts.json')
  const env = { TEST_SSH_PASSWORD: srv.password, USER: 'fixture-user' }

  const tofu = createSshTransport({ connectTimeoutMs: CONNECT_TIMEOUT_MS, knownHostsPolicy: 'tofu', knownHostsPath: khPath, env })
  t.after(() => tofu.dispose())
  const first = await tofu.test(host)
  assert.equal(first.ok, true)
  assert.match(first.warning ?? '', /Trusted new host key/)

  const stored = JSON.parse(await fsp.readFile(khPath, 'utf8'))
  assert.equal(stored.hosts[knownHostId(host)].fingerprint, srv.hostKeyFingerprint)

  const strict = createSshTransport({ connectTimeoutMs: CONNECT_TIMEOUT_MS, knownHostsPolicy: 'strict', knownHostsPath: khPath, env })
  t.after(() => strict.dispose())
  assert.equal((await strict.test(host)).ok, true)

  const strictEmpty = createSshTransport({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    knownHostsPolicy: 'strict',
    knownHostsPath: path.join(khDir, 'empty.json'),
    env,
  })
  t.after(() => strictEmpty.dispose())
  const denied = await strictEmpty.test(host)
  assert.equal(denied.ok, false)
  assert.ok(denied.error instanceof SshError)
  assert.equal(denied.error.code, 'HOST_KEY')

  // A changed fingerprint fails closed with HOST_KEY.
  stored.hosts[knownHostId(host)].fingerprint = 'SHA256:changedFingerprintValue'
  await fsp.writeFile(khPath, JSON.stringify(stored))
  const mismatchTransport = createSshTransport({
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    knownHostsPolicy: 'strict',
    knownHostsPath: khPath,
    env,
  })
  t.after(() => mismatchTransport.dispose())
  const mismatch = await mismatchTransport.test(host)
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.error instanceof SshError)
  assert.equal(mismatch.error.code, 'HOST_KEY')
  assert.match(mismatch.error.message, /does not match|changed/i)

  // insecure accepts any key and the result carries a warning.
  const insecure = createSshTransport({ connectTimeoutMs: CONNECT_TIMEOUT_MS, knownHostsPolicy: 'insecure', env })
  t.after(() => insecure.dispose())
  const accepted = await insecure.test(host)
  assert.equal(accepted.ok, true)
  assert.match(accepted.warning ?? '', /insecure/i)
  const execResult = await insecure.exec(host, { command: 'printf warned' })
  assert.equal(execResult.stdout, 'warned')
  assert.match(execResult.warning ?? '', /insecure/i)
})

/* ================================================================== */
/* ProxyJump                                                          */
/* ================================================================== */

test('proxyJump: single hop jump host forwards to the target', async (t) => {
  const password = 'jump-password'
  const jump = await startSshServer({ password })
  const target = await startSshServer({ password })
  const env = { TEST_SSH_PASSWORD: password, USER: 'fixture-user' }
  const transport = createSshTransport({ connectTimeoutMs: CONNECT_TIMEOUT_MS, knownHostsPolicy: 'insecure', env })
  t.after(async () => {
    transport.dispose()
    await jump.close()
    await target.close()
  })

  const host = {
    id: 'proxied-fixture',
    name: 'proxied-fixture',
    host: '127.0.0.1',
    port: target.port,
    username: target.username,
    passwordEnv: 'TEST_SSH_PASSWORD',
    proxyJump: [`${target.username}@127.0.0.1:${jump.port}`],
  }

  const execResult = await transport.exec(host, { command: 'printf via-jump' })
  assert.equal(execResult.stdout, 'via-jump')
  assert.ok(jump.connectionTotal >= 1, 'the jump host must be used')
  assert.ok(target.connectionTotal >= 1, 'the target must be reached through the jump host')

  assert.equal(await transport.homeDir(host), target.rootDir)
})

/* ================================================================== */
/* interactive PTY channels (v0.2)                                    */
/* ================================================================== */

/**
 * Collect PTY output and provide bounded wait helpers.
 *
 * @param {import('../../lib/ssh/pty.js').PtySession} pty
 */
function attachPtyCollector(pty) {
  let text = ''
  const off = pty.onData((chunk) => {
    text += chunk
  })
  return {
    get text() {
      return text
    },
    off,
    /** @param {string} needle @param {number} [timeoutMs] */
    waitFor(needle, timeoutMs = 6_000) {
      return waitFor(() => text.includes(needle), timeoutMs)
    },
    /** @param {RegExp} pattern @param {number} [timeoutMs] */
    waitForMatch(pattern, timeoutMs = 6_000) {
      return waitFor(() => pattern.test(text), timeoutMs)
    },
  }
}

/**
 * Resolve with the single exit info for a PTY session.
 *
 * @param {import('../../lib/ssh/pty.js').PtySession} pty
 * @param {number} [timeoutMs]
 */
function waitPtyExit(pty, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for PTY exit')), timeoutMs)
    pty.onExit((info) => {
      clearTimeout(timer)
      resolve(info)
    })
  })
}

/**
 * Boot a fixture + transport and guarantee the PTY session is closed before the
 * transport/server teardown hooks run.
 *
 * @param {import('node:test').TestContext} t
 */
async function setupPtyTest(t) {
  const ctx = await setup()
  /** @type {import('../../lib/ssh/pty.js').PtySession|undefined} */
  let pty
  t.after(async () => {
    if (pty) await pty.close().catch(() => {})
    await ctx.close()
  })
  return {
    ...ctx,
    /** @param {object} [options] */
    async open(options = {}) {
      pty = await ctx.transport.openPty(ctx.host, options)
      return pty
    },
  }
}

test('pty: open returns a running session with startup output and requested window', async (t) => {
  const { srv, transport, open, close } = await setupPtyTest(t)
  const pty = await open({ term: 'xterm-256color', cols: 100, rows: 30 })
  try {
    assert.equal(pty.status().kind, 'running')
    assert.equal(pty.term, 'xterm-256color')
    assert.equal(pty.cols, 100)
    assert.equal(pty.rows, 30)
    assert.equal(pty.closed, false)
    assert.equal(transport.poolSize, 1)

    const collector = attachPtyCollector(pty)
    const ready = await collector.waitFor('fixture-shell-ready')
    assert.equal(ready, true, `expected startup output, got ${JSON.stringify(collector.text)}`)
    assert.equal(srv.shellTotal, 1)
    assert.equal(srv.shellCount, 1)
    const session = srv.shellSessions[0]
    assert.equal(session.term, 'xterm-256color')
    assert.equal(session.cols, 100)
    assert.equal(session.rows, 30)
    collector.off()
  } finally {
    await pty.close()
    await close()
  }
})

test('pty: write echo roundtrip (LF and CR both submit)', async (t) => {
  const { open } = await setupPtyTest(t)
  const pty = await open()
  try {
    const collector = attachPtyCollector(pty)
    assert.equal(await collector.waitFor('fixture-shell-ready'), true)

    pty.write('echo pty-ok\n')
    assert.equal(await collector.waitFor('pty-ok'), true, `output was ${JSON.stringify(collector.text)}`)

    // Terminals send "\r" for Enter; the fixture's line-discipline emulation
    // must translate it so the command actually executes.
    pty.write('printf "cr-ok\\n"\r')
    assert.equal(await collector.waitFor('cr-ok'), true)

    // onData returns an unsubscribe function.
    let extra = ''
    const off = pty.onData((chunk) => {
      extra += chunk
    })
    off()
    pty.write('echo after-off\n')
    assert.equal(await collector.waitFor('after-off'), true)
    assert.equal(extra, '', 'unsubscribed listener must not receive data')
    collector.off()
  } finally {
    await pty.close()
  }
})

test('pty: `exit` forwards exit code 0 and status/exit listeners settle', async (t) => {
  const { srv, open } = await setupPtyTest(t)
  const pty = await open()
  const collector = attachPtyCollector(pty)
  assert.equal(await collector.waitFor('fixture-shell-ready'), true)

  let exitCount = 0
  pty.onExit(() => {
    exitCount += 1
  })
  const exitPromise = waitPtyExit(pty)
  pty.write('exit\n')
  const info = await exitPromise
  assert.equal(info.code, 0)
  assert.equal(info.signal, null)
  assert.deepEqual(pty.status(), { kind: 'exited', exitCode: 0, signal: null })
  assert.equal(pty.closed, true)

  await delay(100)
  assert.equal(exitCount, 1, 'onExit must fire exactly once')
  assert.throws(() => pty.write('echo never'), /closed/)
  await pty.close()
  await pty.close()
  assert.equal(srv.shellSessions[0].exitCode, 0)
  collector.off()
})

test('pty: INT interrupts a sleeping command and the shell keeps working', async (t) => {
  const { srv, open } = await setupPtyTest(t)
  const pty = await open()
  try {
    const collector = attachPtyCollector(pty)
    assert.equal(await collector.waitFor('fixture-shell-ready'), true)

    pty.write("printf 'sleep-started\\n'; sleep 30; printf 'slept-done\\n'\n")
    assert.equal(await collector.waitFor('sleep-started'), true, 'the sleep command must start')
    await delay(100)

    // Retry the INT: an interrupt delivered in the tiny window before `sleep`
    // starts would otherwise leave the shell sleeping for 30s.
    let interrupted = false
    for (let attempt = 0; attempt < 3 && !interrupted; attempt += 1) {
      pty.signal('INT')
      pty.write('echo after-int\n')
      interrupted = await collector.waitFor('after-int', 1_500)
    }
    assert.equal(interrupted, true, 'INT must interrupt the sleep promptly')
    assert.equal(collector.text.includes('slept-done'), false, 'the interrupted command list must not continue')
    assert.ok(
      srv.shellSessions[0].signals.includes('SIGINT'),
      `the fixture must receive the signal request, got ${JSON.stringify(srv.shellSessions[0].signals)}`,
    )

    // Unsupported signal names are rejected locally.
    assert.throws(() => pty.signal('NOPE'), TypeError)
    // TSTP is accepted via the "\x1a" fallback (ssh2 cannot send it).
    pty.signal('TSTP')
    collector.off()
  } finally {
    await pty.close()
  }
})

test('pty: resize applies a window-change without throwing, close leaves the pool usable', async (t) => {
  const { srv, transport, host, open } = await setupPtyTest(t)

  // Warm the pool so the re-use assertion is meaningful.
  const warmup = await transport.exec(host, { command: 'printf warmup' })
  assert.equal(warmup.stdout, 'warmup')

  const pty = await open()
  const collector = attachPtyCollector(pty)
  assert.equal(await collector.waitFor('fixture-shell-ready'), true)

  assert.doesNotThrow(() => pty.resize(160, 50))
  const recorded = await waitFor(() => (srv.shellSessions[0]?.windows?.length ?? 0) > 0)
  assert.equal(recorded, true, 'the fixture must observe the window change')
  assert.deepEqual(srv.shellSessions[0].windows[0], { cols: 160, rows: 50 })
  // Invalid sizes are ignored, never thrown.
  assert.doesNotThrow(() => pty.resize(0, -1))

  await pty.close()
  await pty.close()
  assert.equal(pty.closed, true)

  const after = await transport.exec(host, { command: 'printf pooled-ok' })
  assert.equal(after.stdout, 'pooled-ok')
  assert.equal(srv.connectionTotal, 1, 'closing a PTY must not disturb the pooled connection')
  assert.equal(transport.poolSize, 1)
  collector.off()
})

test('pty: abort during open rejects with AbortError and leaves the pool usable', async (t) => {
  const { transport, host } = await setupPtyTest(t)
  const controller = new AbortController()
  const pending = transport.openPty(host, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError')

  const execResult = await transport.exec(host, { command: 'printf aborted-ok' })
  assert.equal(execResult.stdout, 'aborted-ok')

  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    transport.openPty(host, { signal: preAborted.signal }),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
})

test('pty: concurrent shell and exec on one host both succeed', async (t) => {
  const { srv, transport, host, open } = await setupPtyTest(t)
  const pty = await open()
  try {
    const collector = attachPtyCollector(pty)
    assert.equal(await collector.waitFor('fixture-shell-ready'), true)

    // The pooled connection serializes channel ACQUISITION but not the running
    // shell: exec must complete while the PTY stays open.
    const [execResult, echoed] = await Promise.all([
      transport.exec(host, { command: 'printf exec-while-pty' }),
      (async () => {
        pty.write('echo pty-while-exec\n')
        return collector.waitFor('pty-while-exec')
      })(),
    ])
    assert.equal(execResult.stdout, 'exec-while-pty')
    assert.equal(echoed, true)
    assert.equal(srv.connectionTotal, 1, 'shell + exec must share one pooled connection')
    assert.equal(srv.shellCount, 1)

    collector.off()
    await pty.close()
    assert.equal(await waitFor(() => srv.shellCount === 0), true)
    const after = await transport.exec(host, { command: 'printf after-close' })
    assert.equal(after.stdout, 'after-close')
  } finally {
    await pty.close()
  }
})

/* ================================================================== */
/* live exec output streaming (v0.4 onData)                           */
/* ================================================================== */

test('exec onData: streams stdout chunks in arrival order while the command runs', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  /** @type {Array<{stream: string, chunk: string, at: number}>} */
  const events = []
  const result = await transport.exec(host, {
    command: "printf 'a'; sleep 0.2; printf 'b'",
    onData: (data) => events.push({ stream: data.stream, chunk: data.chunk, at: Date.now() }),
  })
  const finishedAt = Date.now()

  assert.equal(result.stdout, 'ab')
  assert.equal(events.length >= 2, true, 'each write must produce its own data event')
  assert.equal(events.every((event) => event.stream === 'stdout'), true)
  assert.equal(events.map((event) => event.chunk).join(''), 'ab')

  const first = events.find((event) => event.chunk.includes('a'))
  const second = events.find((event) => event.chunk.includes('b'))
  assert.ok(first !== undefined && second !== undefined)
  assert.ok(first.at <= second.at, 'chunk arrival order must be preserved')
  // Streaming, not batch-after-exit: the first chunk arrived well before the end.
  assert.ok(first.at < finishedAt - 100, `first chunk should stream early (${finishedAt - first.at}ms before settle)`)
})

test('exec onData: multi-byte UTF-8 split across chunks is decoded safely exactly once', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  /** @type {string[]} */
  const chunks = []
  const result = await transport.exec(host, {
    // 你 (U+4F60) in UTF-8 is e4 bd a0, split by the 150ms pause.
    command: "printf '\\344'; sleep 0.15; printf '\\275\\240'",
    onData: (data) => chunks.push(data.chunk),
  })
  const streamed = chunks.join('')

  assert.equal(result.stdout, '你')
  assert.equal(streamed, '你', `streamed text must equal the decoded result, got ${JSON.stringify(chunks)}`)
  assert.equal(streamed.includes('\uFFFD'), false, 'a split code point must never become U+FFFD')
  assert.equal(streamed.split('你').length - 1, 1, 'the character must be delivered exactly once')
})

test('exec onData: stderr events carry stream "stderr" and stdout stays separate', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  /** @type {Array<{stream: string, chunk: string}>} */
  const events = []
  const result = await transport.exec(host, {
    command: "printf 'std-out'; printf 'err-out' 1>&2; sleep 0.05; printf 'err-more' 1>&2",
    onData: (data) => events.push({ stream: data.stream, chunk: data.chunk }),
  })

  assert.equal(result.stdout, 'std-out')
  assert.equal(result.stderr, 'err-outerr-more')
  assert.equal(events.length > 0, true)
  assert.equal(
    events.every((event) => event.stream === 'stdout' || event.stream === 'stderr'),
    true,
    'every event carries a valid stream tag',
  )
  const stdoutText = events.filter((event) => event.stream === 'stdout').map((event) => event.chunk).join('')
  const stderrText = events.filter((event) => event.stream === 'stderr').map((event) => event.chunk).join('')
  assert.equal(stdoutText, 'std-out')
  assert.equal(stderrText, 'err-outerr-more')
})

test('exec onData: never called after the returned promise settles', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  let calls = 0
  await transport.exec(host, {
    command: 'printf done',
    onData: () => {
      calls += 1
    },
  })
  const callsAtReturn = calls
  await delay(150)
  assert.equal(calls, callsAtReturn, 'no callbacks may fire after await returns')

  // Same guarantee on the timeout path (partial output, then settle).
  let timeoutCalls = 0
  const timedOut = await transport.exec(host, {
    command: 'printf start; sleep 5',
    timeoutMs: 200,
    onData: () => {
      timeoutCalls += 1
    },
  })
  assert.equal(timedOut.timedOut, true)
  const timeoutCallsAtReturn = timeoutCalls
  assert.ok(timeoutCallsAtReturn >= 1)
  await delay(150)
  assert.equal(timeoutCalls, timeoutCallsAtReturn)
})

test('exec onData: streams the full output even when the result tail is truncated', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  /** @type {string[]} */
  const chunks = []
  const command = "awk 'BEGIN{for(i=0;i<5000;i++) printf \"line-%05d\\n\", i}'"
  const result = await transport.exec(host, { command, maxBytes: 1_000, onData: (data) => chunks.push(data.chunk) })

  assert.equal(result.truncated, true)
  assert.equal(result.stdout.length, 1_000, 'the result keeps only the tail')
  assert.equal(result.stdoutBytes, 55_000)
  const streamed = chunks.join('')
  assert.equal(streamed.length, 55_000, 'the live stream is not bounded by maxBytes')
  assert.match(streamed, /^line-00000\n/)
  assert.match(streamed, /line-04999\n$/)
})

test('exec onData: a throwing observer never changes the exec result', async (t) => {
  const { transport, host, close } = await setup()
  t.after(close)

  const result = await transport.exec(host, {
    command: "printf 'safe'; printf 'err' 1>&2; exit 7",
    onData: () => {
      throw new Error('observer exploded')
    },
  })
  assert.equal(result.code, 7)
  assert.equal(result.stdout, 'safe')
  assert.equal(result.stderr, 'err')
})

test('transport.exec onData: chunks flow through the pooled connection path', async (t) => {
  const { srv, transport, host, close } = await setup()
  t.after(close)

  /** @type {string[]} */
  const firstChunks = []
  const first = await transport.exec(host, {
    command: "printf 'one-'; sleep 0.1; printf 'two'",
    onData: (data) => firstChunks.push(data.chunk),
  })
  assert.equal(first.stdout, 'one-two')
  assert.equal(firstChunks.join(''), 'one-two')

  /** @type {string[]} */
  const secondChunks = []
  const second = await transport.exec(host, {
    command: 'printf pooled-stream',
    onData: (data) => secondChunks.push(data.chunk),
  })
  assert.equal(second.stdout, 'pooled-stream')
  assert.equal(secondChunks.join(''), 'pooled-stream')
  assert.equal(srv.connectionTotal, 1, 'onData execs must reuse the pooled connection')

  // Without onData the result is unchanged (regression guard).
  const plain = await transport.exec(host, { command: 'printf plain' })
  assert.equal(plain.stdout, 'plain')
  assert.equal(plain.truncated, false)
})
