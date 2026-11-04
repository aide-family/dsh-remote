import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PEERS = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'])

/** Locate the executing application, never the user's cwd/profile. Electron's
 * resourcesPath is runtime-owned; the verified Desktop runtime layout lives in
 * app.asar/dsh. CLI SDK resolution is anchored at the executing entry script.
 */
export function runtimePeerAnchors({ resourcesPath = process.resourcesPath, entryPath = process.argv[1] } = {}) {
  const anchors = []
  if (typeof resourcesPath === 'string' && resourcesPath) {
    const manifestPath = join(resourcesPath, 'app.asar', 'dsh', 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh-desktop-runtime') anchors.push(manifestPath)
    } catch { /* Non-Desktop process: use the executing CLI or local peers. */ }
  }
  if (typeof entryPath === 'string' && entryPath && process.env.DSH_PROFILE) anchors.push(entryPath)
  return anchors
}

/** Reuse the Harness SDK, including its schema compilation and validators.
 * Linked checkouts and packed packages must not instantiate partial SDK copies
 * whose optional Cordis peers are missing. Only missing-module errors fall back;
 * SDK initialization errors are never hidden.
 */
export async function importRuntimePeer(name) {
  if (!PEERS.has(name)) throw new TypeError('unsupported Harness runtime peer')
  let missing
  for (const anchor of runtimePeerAnchors()) {
    try {
      const resolved = createRequire(anchor).resolve(name)
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error
      missing = error
    }
  }
  try {
    return await import(name)
  } catch (error) {
    if (missing && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND')) {
      throw new Error(`Cannot resolve Harness SDK peer ${name} from the executing application or plugin; restart Harness after replacing a linked installation`, { cause: error })
    }
    throw error
  }
}
