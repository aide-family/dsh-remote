/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/sudo.ts
 */

import { commandBasename } from './shell-wrappers.js'

/**
 * Deliberately narrow: only allow pager-free read-only inspection commands
 * under sudo; everything else is high risk.
 *
 * @param {string[]} argv
 * @param {(command: import('./shell-command.js').SimpleCommand) => import('./types.js').SimpleCommandRisk} classify
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifyReadonlySudo(argv, classify) {
  let i = 1
  if (argv[i] === '-n' || argv[i] === '--non-interactive') i++
  if (argv[i] === '--') i++
  const inner = argv.slice(i)
  const name = commandBasename(inner[0] ?? '')
  // Deliberately narrow: no shell, arbitrary file reader, env override, pager or script.
  if (
    !['systemctl', 'kubectl', 'docker', 'ss', 'df', 'free', 'stat', 'id', 'uname'].includes(name)
  ) {
    return { level: 'high', verb: 'sudo' }
  }
  if (
    inner.some((arg) =>
      /secret|token|credential|shadow|kubeconfig|exec|config|inspect|logs/i.test(arg)
    )
  ) {
    return { level: 'high', verb: 'sudo sensitive/indirect command' }
  }
  if (name === 'systemctl' && !inner.includes('--no-pager'))
    return { level: 'high', verb: 'sudo pager' }
  const risk = classify({ argv: inner, redirects: [], raw: inner.join(' ') })
  return risk.level === 'low' ? risk : { level: 'high', verb: 'sudo ' + risk.verb }
}
