/**
 * Unit tests for `lib/terminal/node-launcher.js` (v0.5.1): the pure launch
 * resolution behind `relay.open().shell.command`.
 *
 * Every branch is driven through the injectable `env` / `execPath` / `versions`
 * / `platform` / `existsSync` / `probeElectronRunAsNode` inputs, so no test
 * spawns a process or depends on the machine's PATH.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  ELECTRON_RUN_AS_NODE_ENV,
  NODE_ENV_VAR,
  buildBridgeCommand,
  bundledNodeCandidates,
  defaultBridgePath,
  defaultLauncherPath,
  probeElectronRunAsNode,
  resolveNodeLaunch,
  resolveNodeLauncher,
  shellQuote,
} from '../../lib/terminal/node-launcher.js'

const MAC_EXEC = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

/** @param {Record<string, any>} [overrides] */
function options(overrides = {}) {
  return {
    env: {},
    execPath: '/opt/node/bin/node',
    versions: {},
    platform: 'linux',
    existsSync: () => true,
    probeElectronRunAsNode: () => false,
    ...overrides,
  }
}

/* ------------------------------------------------------------------------- */
/* Quoting + defaults                                                        */
/* ------------------------------------------------------------------------- */

test('node-launcher: shellQuote is POSIX single quoting', () => {
  assert.equal(shellQuote('abc'), "'abc'")
  assert.equal(shellQuote('a b'), "'a b'")
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.equal(shellQuote(''), "''")
  assert.equal(shellQuote(42), "'42'")
  assert.equal(shellQuote('$HOME `id` "x"'), "'$HOME `id` \"x\"'")
})

test('node-launcher: default launcher and bridge paths are absolute and packaged', () => {
  const launcher = defaultLauncherPath()
  const bridge = defaultBridgePath()
  assert.ok(path.isAbsolute(launcher))
  assert.ok(launcher.endsWith(`${path.sep}bin${path.sep}dsh-remote-terminal`))
  assert.ok(path.isAbsolute(bridge))
  assert.ok(bridge.endsWith(`${path.sep}lib${path.sep}terminal${path.sep}bridge.cjs`))
  // The files this package ships must exist next to the module.
  assert.equal(existsSync(launcher), true)
  assert.equal(existsSync(bridge), true)
})

test('node-launcher: exported environment variable names are stable', () => {
  assert.equal(NODE_ENV_VAR, 'DSH_REMOTE_NODE')
  assert.equal(ELECTRON_RUN_AS_NODE_ENV, 'ELECTRON_RUN_AS_NODE')
})

/* ------------------------------------------------------------------------- */
/* Branch 1: $DSH_REMOTE_NODE                                                */
/* ------------------------------------------------------------------------- */

test('node-launcher: $DSH_REMOTE_NODE wins when it names an existing executable', () => {
  const launch = resolveNodeLaunch(
    options({
      env: { DSH_REMOTE_NODE: '  /custom/node  ' },
      versions: { electron: '30.0.0' },
      existsSync: (candidate) => candidate === '/custom/node',
      probeElectronRunAsNode: () => {
        throw new Error('the env override must short-circuit the Electron probe')
      },
    }),
  )
  assert.equal(launch.kind, 'env')
  assert.equal(launch.launcher, false)
  assert.equal(launch.prefix, "'/custom/node'")
  assert.equal(resolveNodeLauncher({ env: { DSH_REMOTE_NODE: '/custom/node' }, existsSync: () => true }), "'/custom/node'")
})

test('node-launcher: a missing $DSH_REMOTE_NODE path falls through to execPath', () => {
  const launch = resolveNodeLaunch(
    options({ env: { DSH_REMOTE_NODE: '/nope/node' }, existsSync: () => false }),
  )
  assert.equal(launch.kind, 'node')
  assert.equal(launch.prefix, "'/opt/node/bin/node'")
})

/* ------------------------------------------------------------------------- */
/* Branch 2: plain node execPath                                             */
/* ------------------------------------------------------------------------- */

test('node-launcher: a non-Electron Host uses execPath directly', () => {
  const launch = resolveNodeLaunch(
    options({
      execPath: '/usr/local/bin/node',
      versions: { node: '22.21.1' },
      existsSync: () => false,
      probeElectronRunAsNode: () => {
        throw new Error('no probe without Electron')
      },
    }),
  )
  assert.deepEqual(launch, { prefix: "'/usr/local/bin/node'", kind: 'node', launcher: false })
})

/* ------------------------------------------------------------------------- */
/* Branch 3: ELECTRON_RUN_AS_NODE probe                                      */
/* ------------------------------------------------------------------------- */

test('node-launcher: Electron + a succeeding probe uses `env ELECTRON_RUN_AS_NODE=1`', () => {
  let probes = 0
  const launch = resolveNodeLaunch(
    options({
      execPath: MAC_EXEC,
      versions: { electron: '30.0.0' },
      platform: 'darwin',
      existsSync: () => false,
      probeElectronRunAsNode: (execPath) => {
        probes += 1
        assert.equal(execPath, MAC_EXEC)
        return true
      },
    }),
  )
  assert.equal(probes, 1)
  assert.equal(launch.kind, 'electron-run-as-node')
  assert.equal(launch.launcher, false)
  assert.equal(launch.prefix, `env ELECTRON_RUN_AS_NODE=1 '${MAC_EXEC}'`)
})

test('node-launcher: Electron + a failing or throwing probe falls through to a bundled node', () => {
  const bundled = path.join('/Applications/DeepSeek Harness.app/Contents/Resources', 'runtime', 'bin', 'node')
  for (const probe of [
    () => false,
    () => {
      throw new Error('probe boom')
    },
  ]) {
    const launch = resolveNodeLaunch(
      options({
        execPath: MAC_EXEC,
        versions: { electron: '30.0.0' },
        platform: 'darwin',
        existsSync: (candidate) => candidate === bundled,
        probeElectronRunAsNode: probe,
      }),
    )
    assert.equal(launch.kind, 'bundled')
    assert.equal(launch.prefix, shellQuote(bundled))
  }
})

/* ------------------------------------------------------------------------- */
/* Branch 4: bundled runtime node                                            */
/* ------------------------------------------------------------------------- */

test('node-launcher: bundled node candidates follow the macOS and Windows/Linux layouts', () => {
  assert.deepEqual(bundledNodeCandidates(MAC_EXEC, 'darwin'), [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node',
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',
  ])
  assert.deepEqual(bundledNodeCandidates('/opt/app/app', 'linux'), [
    '/opt/app/resources/runtime/bin/node',
    '/opt/app/resources/runtime/primary-runtime/dependencies/node/bin/node',
  ])
  const windows = bundledNodeCandidates('C:\\Program Files\\App\\App.exe', 'win32')
  assert.deepEqual(windows, [
    'C:\\Program Files\\App\\resources\\runtime\\bin\\node.exe',
    'C:\\Program Files\\App\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
  ])
  assert.equal(windows.every((candidate) => candidate.startsWith('C:\\Program Files\\App\\resources\\')), true)
})

test('node-launcher: a bundled runtime node next to execPath is used before the launcher', () => {
  const [first, second] = bundledNodeCandidates(MAC_EXEC, 'darwin')
  const launch = resolveNodeLaunch(
    options({
      execPath: MAC_EXEC,
      versions: { electron: '30.0.0' },
      platform: 'darwin',
      existsSync: (candidate) => candidate === second,
      probeElectronRunAsNode: () => false,
    }),
  )
  assert.equal(launch.kind, 'bundled')
  assert.equal(launch.prefix, shellQuote(second))
  assert.notEqual(first, second)
})

/* ------------------------------------------------------------------------- */
/* Branch 5: launcher fallback                                               */
/* ------------------------------------------------------------------------- */

test('node-launcher: the POSIX launcher is the final fallback', () => {
  const launch = resolveNodeLaunch(
    options({
      execPath: MAC_EXEC,
      versions: { electron: '30.0.0' },
      platform: 'darwin',
      existsSync: () => false,
      probeElectronRunAsNode: () => false,
    }),
  )
  assert.equal(launch.kind, 'launcher')
  assert.equal(launch.launcher, true)
  assert.equal(launch.prefix, shellQuote(defaultLauncherPath()))
  assert.ok(launch.prefix.endsWith(`${path.sep}bin${path.sep}dsh-remote-terminal'`))
})

test('node-launcher: launcher fallback also covers an empty execPath', () => {
  const launch = resolveNodeLaunch(options({ execPath: '', versions: {} }))
  assert.equal(launch.kind, 'launcher')
  assert.equal(launch.launcher, true)
})

/* ------------------------------------------------------------------------- */
/* The exact command line                                                    */
/* ------------------------------------------------------------------------- */

test('node-launcher: buildBridgeCommand emits the v0.5.1 exec line for a node launch', () => {
  const launch = resolveNodeLaunch(options({ execPath: '/opt/node/bin/node' }))
  const command = buildBridgeCommand({ host: 'me', session: 'session-1', socket: '/home/u/.dsh/remote/terminal.sock', launch })
  assert.equal(
    command,
    `exec '/opt/node/bin/node' '${defaultBridgePath()}' --host 'me' --session 'session-1' --socket '/home/u/.dsh/remote/terminal.sock'`,
  )
})

test('node-launcher: buildBridgeCommand shell-quotes every argument', () => {
  const launch = { prefix: "'/opt/node/bin/node'", launcher: false }
  const command = buildBridgeCommand({ host: "a'b", session: 's 1', socket: '/tmp/x.sock', launch })
  assert.match(command, /^exec '\/opt\/node\/bin\/node' '.*bridge\.cjs' --host 'a'\\''b' --session 's 1' --socket '\/tmp\/x\.sock'$/u)
})

test('node-launcher: the launcher fallback keeps its own bridge path (no bridge argument)', () => {
  const command = buildBridgeCommand({
    host: 'me',
    session: 's',
    socket: '/tmp/terminal.sock',
    launch: { prefix: shellQuote(defaultLauncherPath()), launcher: true },
  })
  assert.equal(command, `exec '${defaultLauncherPath()}' --host 'me' --session 's' --socket '/tmp/terminal.sock'`)
  assert.doesNotMatch(command, /bridge\.cjs/u)
})

test('node-launcher: buildBridgeCommand rejects an unresolved launch', () => {
  assert.throws(() => buildBridgeCommand({ host: 'h', session: 's', socket: 'p' }), TypeError)
  assert.throws(
    () => buildBridgeCommand({ host: 'h', session: 's', socket: 'p', launch: { prefix: '', launcher: false } }),
    TypeError,
  )
})

/* ------------------------------------------------------------------------- */
/* Default probe behaviour (never throws)                                    */
/* ------------------------------------------------------------------------- */

test('node-launcher: the default Electron probe is safe and cached for a missing binary', () => {
  const missing = '/definitely/not/a/real/executable-dsh-remote'
  assert.equal(probeElectronRunAsNode(missing), false)
  assert.equal(probeElectronRunAsNode(missing), false)
  assert.equal(probeElectronRunAsNode(''), false)
})
