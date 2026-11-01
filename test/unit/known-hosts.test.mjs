/**
 * Unit tests for lib/ssh/known-hosts.js — TOFU / strict / insecure policies,
 * sha256 fingerprints, persistence and corruption handling.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createKnownHosts,
  defaultKnownHostsPath,
  fingerprintSha256,
  hostKeyAlgorithm,
  KNOWN_HOSTS_POLICIES,
  knownHostId,
} from '../../lib/ssh/known-hosts.js'

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Deterministic fake "host key" blobs for fingerprint tests. */
const KEY_A = Buffer.from('fixture-host-key-A')
const KEY_B = Buffer.from('fixture-host-key-B')

const HOST = { host: '10.0.0.11', port: 2222 }
const HOST_ID = '10.0.0.11:2222'

test('known-hosts: policy list and default store path', () => {
  assert.deepEqual([...KNOWN_HOSTS_POLICIES], ['tofu', 'strict', 'insecure'])
  assert.equal(defaultKnownHostsPath({ DSH_HOME: '/tmp/dsh-home' }, '/home/example'), path.join('/tmp/dsh-home', 'remote', 'known-hosts.json'))
  assert.equal(defaultKnownHostsPath({}, '/home/example'), path.join('/home/example', '.dsh', 'remote', 'known-hosts.json'))
})

test('known-hosts: sha256 fingerprint format is OpenSSH SHA256:<base64> without padding', () => {
  const fingerprint = fingerprintSha256(KEY_A)
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/)
  assert.equal(fingerprint.endsWith('='), false)
  assert.equal(fingerprint, fingerprintSha256(KEY_A))
  assert.notEqual(fingerprint, fingerprintSha256(KEY_B))
  // 32 bytes sha256 -> 43 base64 chars without padding
  assert.equal(fingerprint.slice('SHA256:'.length).length, 43)
})

test('known-hosts: store key includes non-default port and brackets ipv6', () => {
  assert.equal(knownHostId({ host: '10.0.0.11' }), '10.0.0.11')
  assert.equal(knownHostId({ host: '10.0.0.11', port: 22 }), '10.0.0.11')
  assert.equal(knownHostId({ host: '10.0.0.11', port: 2222 }), '10.0.0.11:2222')
  assert.equal(knownHostId({ host: '::1', port: 22 }), '[::1]')
  assert.equal(knownHostId({ host: '::1', port: 2200 }), '[::1]:2200')
})

test('known-hosts: tofu trusts and persists an unknown key, then accepts it', async (t) => {
  const dir = await tempDir('dsh-remote-kh-tofu-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'nested', 'known-hosts.json')
  const knownHosts = createKnownHosts({ policy: 'tofu', filePath })

  const first = await knownHosts.check(HOST, KEY_A)
  assert.equal(first.ok, true)
  assert.equal(first.status, 'unknown')
  assert.equal(first.fingerprint, fingerprintSha256(KEY_A))
  assert.equal(first.hostId, HOST_ID)
  assert.match(first.warning ?? '', /Trusted new host key/)
  assert.match(first.warning ?? '', /SHA256:/)

  const stored = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.hosts[HOST_ID].fingerprint, fingerprintSha256(KEY_A))
  assert.equal(typeof stored.hosts[HOST_ID].addedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(stored.hosts[HOST_ID].addedAt)))

  const second = await knownHosts.check(HOST, KEY_A)
  assert.equal(second.ok, true)
  assert.equal(second.status, 'stored')
  assert.equal(second.warning, undefined)

  // A different key for a known host is a hard mismatch even in tofu mode.
  const third = await knownHosts.check(HOST, KEY_B)
  assert.equal(third.ok, false)
  assert.equal(third.status, 'mismatch')
  assert.equal(third.expected, fingerprintSha256(KEY_A))
  assert.equal(third.fingerprint, fingerprintSha256(KEY_B))
  assert.match(third.warning ?? '', /changed/)
})

test('known-hosts: tofu store is atomic JSON and keeps unrelated hosts', async (t) => {
  const dir = await tempDir('dsh-remote-kh-atomic-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'known-hosts.json')
  const knownHosts = createKnownHosts({ policy: 'tofu', filePath })

  await Promise.all([
    knownHosts.check({ host: 'one.example.com' }, KEY_A),
    knownHosts.check({ host: 'two.example.com', port: 2222 }, KEY_B),
    knownHosts.check({ host: 'three.example.com' }, Buffer.from('key-c')),
  ])

  const stored = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  assert.deepEqual(Object.keys(stored.hosts).sort(), ['one.example.com', 'three.example.com', 'two.example.com:2222'])
  const listed = await knownHosts.list()
  assert.equal(Object.keys(listed).length, 3)
  // No temp files are left behind by the atomic write.
  const entries = await fsp.readdir(dir)
  assert.deepEqual(entries, ['known-hosts.json'])
})

test('known-hosts: strict rejects unknown keys and accepts stored ones', async (t) => {
  const dir = await tempDir('dsh-remote-kh-strict-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'known-hosts.json')

  const strict = createKnownHosts({ policy: 'strict', filePath })
  const unknown = await strict.check(HOST, KEY_A)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.status, 'unknown')
  assert.match(unknown.warning ?? '', /strict/)
  assert.equal(await fsp.readFile(filePath, 'utf8').catch(() => null), null, 'strict never writes the store')

  // Seed via a tofu store, then strict accepts the same key.
  await createKnownHosts({ policy: 'tofu', filePath }).check(HOST, KEY_A)
  const accepted = await strict.check(HOST, KEY_A)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.status, 'stored')

  const mismatch = await strict.check(HOST, KEY_B)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.status, 'mismatch')
})

test('known-hosts: insecure accepts any key with a warning and never persists', async (t) => {
  const dir = await tempDir('dsh-remote-kh-insecure-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'known-hosts.json')
  const insecure = createKnownHosts({ policy: 'insecure', filePath })

  const first = await insecure.check(HOST, KEY_A)
  assert.equal(first.ok, true)
  assert.equal(first.status, 'insecure')
  assert.match(first.warning ?? '', /insecure/)

  const second = await insecure.check(HOST, KEY_B)
  assert.equal(second.ok, true)
  assert.match(second.warning ?? '', /insecure/)
  assert.equal(await fsp.readFile(filePath, 'utf8').catch(() => null), null, 'insecure never writes the store')
})

test('known-hosts: corrupt store is treated as empty (strict fails closed)', async (t) => {
  const dir = await tempDir('dsh-remote-kh-corrupt-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'known-hosts.json')
  await fsp.writeFile(filePath, '{ not json')

  const strict = createKnownHosts({ policy: 'strict', filePath })
  const rejected = await strict.check(HOST, KEY_A)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.status, 'unknown')

  // Tofu overwrites the corrupt store with valid JSON.
  const tofu = createKnownHosts({ policy: 'tofu', filePath })
  const accepted = await tofu.check(HOST, KEY_A)
  assert.equal(accepted.ok, true)
  const stored = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  assert.equal(stored.hosts[HOST_ID].fingerprint, fingerprintSha256(KEY_A))
})

test('known-hosts: unknown policy falls back to tofu with a warning', async (t) => {
  const dir = await tempDir('dsh-remote-kh-policy-')
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  /** @type {string[]} */
  const warnings = []
  const knownHosts = createKnownHosts({
    policy: 'bogus',
    filePath: path.join(dir, 'known-hosts.json'),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  })
  assert.equal(knownHosts.policy, 'tofu')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /bogus/)
})

test('known-hosts: hostKeyAlgorithm returns ssh key type for raw blob and undefined otherwise', () => {
  // A raw "ssh-ed25519" blob crafted by hand (type string + 32 byte key).
  const type = Buffer.from('ssh-ed25519')
  const key = Buffer.alloc(32, 7)
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, key.length]),
    key,
  ])
  assert.equal(hostKeyAlgorithm(blob), 'ssh-ed25519')
  assert.equal(hostKeyAlgorithm(Buffer.from('not a key')), undefined)
})
