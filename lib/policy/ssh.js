/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/ssh.ts
 */

import { classifyPeeledInner } from './shell-wrappers.js'

/**
 * Extract the remote command from an `ssh` invocation when (and only when) the
 * invocation is a plain query: no forwards, no local commands, no arbitrary
 * options. Returns null when the shape cannot be proven safe to peel.
 *
 * @param {string[]} argv
 * @returns {string[] | null}
 */
export function extractSshRemoteCommand(argv) {
  let i = 1
  while (i < argv.length && argv[i].startsWith('-')) {
    const token = argv[i++]
    if (['-T', '-n', '-q', '-4', '-6'].includes(token)) continue
    if (['-p', '-l', '-i'].includes(token)) {
      if (!argv[i] || argv[i].startsWith('-')) return null
      i++
      continue
    }
    if (token === '-o' || token.startsWith('-o')) {
      const option = token === '-o' ? argv[i++] : token.slice(2)
      if (
        !option ||
        !/^(BatchMode=yes|ConnectTimeout=\d+|StrictHostKeyChecking=yes|IdentitiesOnly=yes)$/i.test(
          option
        )
      )
        return null
      continue
    }
    // Forwards, local commands, alternate config and interactive flags are not queries.
    return null
  }
  const host = argv[i++]
  if (!host || !/^[\w.@:[\]-]+$/.test(host) || i >= argv.length) return null
  return argv.slice(i)
}

/**
 * @param {string[]} argv
 * @param {(command: import('./shell-command.js').SimpleCommand) => import('./types.js').SimpleCommandRisk} classify
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifySsh(argv, classify) {
  const remote = extractSshRemoteCommand(argv)
  if (!remote) return { level: 'gray', verb: 'ssh' }
  return classifyPeeledInner(remote, classify)
}
