/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/shell-wrappers.ts
 */

import { collectSimpleCommands } from './shell-command.js'

export const DURATION = /^(?:\d+(?:\.\d+)?)[smhd]?$/

export const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Peel generic command wrappers (`timeout`, `command`, `nice`, `stdbuf`,
 * `nohup`, `time`, `env`) until a real command remains.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripWrappers(argv) {
  let current = [...argv]
  for (let guard = 0; guard < 8 && current.length > 0; guard++) {
    const cmd = commandBasename(current[0] ?? '')
    if (cmd === 'timeout') {
      current = skipTimeout(current)
      continue
    }
    if (cmd === 'command') {
      current = current.slice(1)
      while (current[0]?.startsWith('-')) current = current.slice(1)
      continue
    }
    if (cmd === 'nice' || cmd === 'stdbuf' || cmd === 'nohup' || cmd === 'time') {
      current = current.slice(1)
      while (current[0]?.startsWith('-')) {
        const flag = current[0]
        if (
          (flag === '-n' || flag === '-e' || flag === '-o' || flag === '-i') &&
          !flag.includes('=')
        ) {
          current = current.slice(2)
          continue
        }
        current = current.slice(1)
      }
      continue
    }
    if (cmd === 'env') {
      let i = 1
      while (i < current.length && current[i]?.startsWith('-') && !ASSIGN.test(current[i] ?? '')) {
        if (current[i] === '-u' || current[i] === '--unset') i += 2
        else i += 1
      }
      while (i < current.length && ASSIGN.test(current[i] ?? '')) i += 1
      if (i >= current.length) return current
      current = current.slice(i)
      continue
    }
    break
  }
  return current
}

/**
 * @param {string[]} argv
 * @returns {string[]}
 */
export function skipTimeout(argv) {
  let i = 1
  while (i < argv.length && argv[i]?.startsWith('-')) {
    const flag = argv[i] ?? ''
    if (
      (flag === '-k' || flag === '--kill-after' || flag === '-s' || flag === '--signal') &&
      !flag.includes('=')
    ) {
      i += 2
      continue
    }
    i += 1
  }
  if (i < argv.length && DURATION.test(argv[i] ?? '')) i += 1
  return argv.slice(i)
}

/**
 * @param {string} token
 * @returns {string}
 */
export function commandBasename(token) {
  const parts = token.replace(/\\/g, '/').split('/')
  return (parts[parts.length - 1] ?? token).toLowerCase()
}

/**
 * Classify the script payload of a peeled shell (`sh -c '…'`, `ssh host '…'`,
 * `kubectl exec … -- '…'`, `docker exec … '…'`).
 *
 * @param {string[]} innerArgv
 * @param {(command: import('./shell-command.js').SimpleCommand) => import('./types.js').SimpleCommandRisk} classify
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifyPeeledInner(innerArgv, classify) {
  const unwrapped = unwrapShellScript(innerArgv)
  const innerStr = unwrapped ?? innerArgv.join(' ')
  if (!innerStr.trim()) return { level: 'gray', verb: 'change' }

  const commands = collectSimpleCommands(innerStr)
  if (!commands || commands.length === 0) return { level: 'gray', verb: 'change' }

  let sawGray = false
  let firstVerb
  for (const cmd of commands) {
    const risk = classify(cmd)
    if (risk.level === 'high') return risk
    if (risk.level === 'gray') sawGray = true
    firstVerb ??= risk.verb
  }
  if (sawGray) return { level: 'gray', verb: firstVerb ?? 'change' }
  return { level: 'low', verb: firstVerb ?? 'change' }
}

/**
 * Extract the `-c` payload of a shell invocation.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function unwrapShellScript(argv) {
  if (argv.length < 2) return null
  const shell = commandBasename(argv[0] ?? '')
  if (!SHELL_NAMES.has(shell)) return null

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '-c' || token === '--command') {
      return argv[i + 1] ?? null
    }
    if (token.startsWith('-c') && token.length > 2) {
      return token.slice(2)
    }
  }
  return null
}
