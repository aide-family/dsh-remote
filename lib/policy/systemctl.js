/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/systemctl.ts
 */

import { firstKnownVerb } from './argv.js'

export const SYSTEMCTL_WRITE = new Set(['restart', 'reload', 'stop', 'start', 'enable', 'disable'])

export const SYSTEMCTL_READ = new Set(['status', 'is-active', 'list-units', 'show', 'list-timers'])

/**
 * @param {string[]} argv
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifySystemctl(argv) {
  const verb = firstKnownVerb(argv, SYSTEMCTL_WRITE, SYSTEMCTL_READ)
  if (verb && SYSTEMCTL_WRITE.has(verb)) return { level: 'high', verb: `systemctl ${verb}` }
  if (argv.includes('--root') || argv.some((arg) => arg.startsWith('--root=')))
    return { level: 'gray', verb: 'systemctl root' }
  if (verb && SYSTEMCTL_READ.has(verb)) return { level: 'low', verb: `systemctl ${verb}` }
  return { level: 'gray', verb: 'systemctl' }
}
