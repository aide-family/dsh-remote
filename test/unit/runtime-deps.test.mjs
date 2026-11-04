import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimePeerAnchors, importRuntimePeer } from '../../lib/runtime-deps.js'

test('SDK resolution uses a verified runtime anchor and preserves real module exports', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-runtime-peers-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = join(dir, 'app.asar', 'dsh')
  await mkdir(runtime, { recursive: true })
  const manifest = join(runtime, 'package.json')
  await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  assert.deepEqual(runtimePeerAnchors({ resourcesPath: dir, entryPath: '' }), [manifest])
  await writeFile(manifest, JSON.stringify({ name: 'not-a-harness-runtime' }))
  assert.deepEqual(runtimePeerAnchors({ resourcesPath: dir, entryPath: '' }), [])
  await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime' }))
  for (const [name, code, type] of [
    ['dsh-tools', 'export const defineTool = (definition) => ({ ...definition, compiled: true });', 'module'],
    ['schemastery', 'module.exports = function FixtureSchema() {};', 'commonjs'],
  ]) {
    const packageDir = join(runtime, 'node_modules', '@deepseek-ai', name)
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, type, exports: './index.js' }))
    await writeFile(join(packageDir, 'index.js'), code)
  }
  const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: dir })
  t.after(() => {
    if (previous) Object.defineProperty(process, 'resourcesPath', previous)
    else delete process.resourcesPath
  })
  const tools = await importRuntimePeer('@deepseek-ai/dsh-tools')
  assert.equal(tools.defineTool({ name: 'fixture' }).compiled, true)
  const schema = await importRuntimePeer('@deepseek-ai/schemastery')
  assert.equal(typeof schema.default, 'function')
  await assert.rejects(importRuntimePeer('untrusted-arbitrary-module'), TypeError)
})
