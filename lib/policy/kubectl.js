/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/kubectl.ts
 */

import { findVerbIndex, firstKnownVerb } from './argv.js'
import { classifyPeeledInner } from './shell-wrappers.js'

export const KUBECTL_WRITE = new Set([
  'delete',
  'apply',
  'patch',
  'edit',
  'rollout',
  'scale',
  'drain',
  'cordon',
  'create',
  'replace',
  'port-forward'
])

export const KUBECTL_READ = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'cluster-info',
  'version',
  'api-resources',
  'config',
  'auth',
  'diff',
  'wait'
])

export const KUBECTL_EXEC_FLAGS_WITH_VALUE = new Set([
  '-c',
  '--container',
  '-n',
  '--namespace',
  '--kubeconfig',
  '--context'
])

/**
 * @param {string[]} argv
 * @param {number} start
 * @returns {number}
 */
export function skipKubectlExecFlags(argv, start) {
  let i = start
  while (i < argv.length) {
    const token = argv[i] ?? ''
    if (token === '--') return i
    if (!token.startsWith('-')) return i

    const eq = token.indexOf('=')
    if (eq > 0) {
      i += 1
      continue
    }
    const lower = token.toLowerCase()
    if (KUBECTL_EXEC_FLAGS_WITH_VALUE.has(lower)) {
      i += 2
      continue
    }
    if (lower === '-i' || lower === '-t' || lower === '-it') {
      i += 1
      continue
    }
    i += 1
  }
  return i
}

/**
 * @param {string[]} argv
 * @returns {string[] | null}
 */
export function extractKubectlExecInner(argv) {
  const execIdx = findVerbIndex(argv, 'exec')
  if (execIdx < 0) return null

  let i = skipKubectlExecFlags(argv, execIdx + 1)
  if (i >= argv.length) return null

  if (argv[i] === '--') {
    const rest = argv.slice(i + 1)
    return rest.length > 0 ? rest : null
  }

  i += 1
  if (i >= argv.length) return null

  if (argv[i] === '--') {
    const rest = argv.slice(i + 1)
    return rest.length > 0 ? rest : null
  }

  const rest = argv.slice(i)
  return rest.length > 0 ? rest : null
}

/**
 * @param {string[]} argv
 * @param {(command: import('./shell-command.js').SimpleCommand) => import('./types.js').SimpleCommandRisk} classify
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifyKubectl(argv, classify) {
  const verb = firstKnownVerb(argv, KUBECTL_WRITE, KUBECTL_READ)
  if (verb === 'exec' || findVerbIndex(argv, 'exec') >= 0) {
    const inner = extractKubectlExecInner(argv)
    if (!inner) return { level: 'gray', verb: 'kubectl exec' }
    return classifyPeeledInner(inner, classify)
  }
  if (verb && KUBECTL_WRITE.has(verb)) return { level: 'high', verb: `kubectl ${verb}` }
  if (
    verb === 'config' &&
    !argv.some((arg) => ['current-context', 'get-contexts', 'view'].includes(arg))
  )
    return { level: 'gray', verb: 'kubectl config' }
  if (verb === 'auth' && !argv.includes('can-i')) return { level: 'gray', verb: 'kubectl auth' }
  if (argv.some((arg) => /^(secrets?|--raw)(=|$)/i.test(arg)))
    return { level: 'gray', verb: 'kubectl sensitive query' }
  if (verb && KUBECTL_READ.has(verb)) return { level: 'low', verb: `kubectl ${verb}` }
  return { level: 'gray', verb: 'kubectl' }
}
