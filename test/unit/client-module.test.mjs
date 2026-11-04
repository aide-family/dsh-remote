import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const root = new URL('../../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const bundle = await readFile(new URL(manifest.exports['./client'], root), 'utf8')

// The Harness loader keys graph rows by package name. If a bundle registers a
// different id, the row stays missing and fallback execution registers that
// wrong id twice. Keep this test independent of optional Harness peers.
test('Client bundle registers the exact package id expected by Harness boot', () => {
  const registrations = new Map()
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(registration) {
          assert.equal(registration.id, manifest.name, 'Client factory id must match the package name')
          assert.equal(typeof registration.factory, 'function')
          assert.equal(registrations.has(registration.id), false, 'a boot script must register only once')
          registrations.set(registration.id, registration)
        },
      },
    },
  })
  vm.runInContext(bundle, context, { filename: 'lib/client.js', timeout: 1_000 })
  assert.equal(registrations.size, 1)
  assert.ok(registrations.has(manifest.name), 'the boot graph row must be satisfied without fallback execution')
})

test('Client factory materializes lazily with only the baseline React module', () => {
  let registration
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  }, { filename: 'lib/client.js', timeout: 1_000 })
  const imports = []
  const plugin = registration.factory((name) => {
    imports.push(name)
    assert.equal(name, 'react')
    return { createElement() {} }
  })
  assert.deepEqual(imports, ['react'])
  assert.equal(typeof plugin.apply, 'function')
})
