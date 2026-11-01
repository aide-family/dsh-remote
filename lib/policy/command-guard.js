/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-guard.ts
 * (the static classification core: HIGH/READONLY token sets, per-simple-command
 * rules, and the `extractRiskVerb` / `isStaticallyReadonly` / `hasHighWriteVerb`
 * helpers).
 *
 * Crescent's own whitelist-normalisation helpers (`normalizeCommand`,
 * `matchGlobCommand`, `shouldShowWhitelistEntry`) are approval-UI utilities and
 * are intentionally not part of the dsh-remote policy contract.
 */

import { classifyDocker } from './docker.js'
import {
  hasFindMutation,
  hasSedInPlace,
  hasUnsafeInspectionArguments,
  hasYqInPlace,
  isReadonlyCurl,
  isSysctlWrite
} from './inspection.js'
import { classifyKubectl } from './kubectl.js'
import {
  SHELL_NAMES,
  classifyPeeledInner,
  commandBasename,
  stripWrappers
} from './shell-wrappers.js'
import { classifySsh } from './ssh.js'
import { classifyReadonlySudo } from './sudo.js'
import { classifySystemctl } from './systemctl.js'
import { collectSimpleCommands } from './shell-command.js'

const KUBECTL_BEFORE_VERB = String.raw`\bkubectl(?:\s+[^\s]+)*?\s+`

export const HIGH = new RegExp(
  String.raw`\b(rm|mv|dd|kill|reboot)\b|systemctl\s+(restart|stop|start|enable|disable)|` +
    KUBECTL_BEFORE_VERB +
    String.raw`(delete|apply|patch|edit|rollout|scale|drain|cordon|create|replace)|` +
    String.raw`docker\s+(rm|rmi|restart|stop|run)|\b(chmod|chown|tee)\b`
)

export const READONLY = new RegExp(
  KUBECTL_BEFORE_VERB +
    String.raw`(get|describe|logs|top|explain|cluster-info|version|api-resources|config|auth|diff|wait)|` +
    String.raw`docker\s+(ps|inspect|logs|images|stats|version|info|history|port)|` +
    String.raw`docker\s+compose\s+(ps|logs|config)|` +
    String.raw`systemctl\s+(status|is-active|list-units|show|list-timers)|journalctl|` +
    String.raw`\b(cat|ls|echo|hostname|whoami|uname|ps|df|free|top|ss|awk|grep|head|tail|wc|which|find|stat|id|pwd|env|printenv|lsof|du|uptime|ip|sort|uniq|cut|tr|column|date|hostnamectl|jq|printf|sed)\b|` +
    String.raw`curl\s+(-[a-zA-Z]*s|--max-time)`
)

const PRESERVE_TOKENS = new Set([
  'kubectl',
  'docker',
  'systemctl',
  'journalctl',
  'curl',
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
  'wait',
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
  'exec',
  'ps',
  'inspect',
  'images',
  'stats',
  'info',
  'history',
  'port',
  'compose',
  'rm',
  'rmi',
  'restart',
  'stop',
  'run',
  'status',
  'is-active',
  'list-units',
  'show',
  'list-timers',
  'cat',
  'ls',
  'echo',
  'hostname',
  'whoami',
  'uname',
  'df',
  'free',
  'ss',
  'awk',
  'grep',
  'head',
  'tail',
  'wc',
  'which',
  'find',
  'stat',
  'id',
  'pwd',
  'env',
  'printenv',
  'lsof',
  'du',
  'uptime',
  'ip',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'date',
  'hostnamectl',
  'jq',
  'printf',
  'sed',
  'mv',
  'dd',
  'kill',
  'reboot',
  'chmod',
  'chown',
  'tee',
  'pod',
  'pods',
  'deploy',
  'deployment',
  'deployments',
  'svc',
  'service',
  'services',
  'ns',
  'namespace',
  'namespaces',
  'node',
  'nodes',
  'configmap',
  'secret',
  'secrets',
  '&&',
  '||',
  '|',
  ';',
  '>',
  '>>',
  '2>',
  '2>&1'
])

const SIMPLE_WRITE = new Set([
  'rm',
  'mv',
  'cp',
  'install',
  'mkdir',
  'touch',
  'dd',
  'kill',
  'reboot',
  'chmod',
  'chown',
  'tee'
])

const SIMPLE_READ = new Set([
  'cmp',
  'sha256sum',
  'shasum',
  'cat',
  'ls',
  'echo',
  'printf',
  'hostname',
  'hostnamectl',
  'whoami',
  'uname',
  'ps',
  'df',
  'free',
  'top',
  'ss',
  'awk',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
  'wc',
  'which',
  'find',
  'stat',
  'id',
  'pwd',
  'env',
  'printenv',
  'lsof',
  'du',
  'uptime',
  'ip',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'date',
  'jq',
  'sed',
  'journalctl',
  'test',
  '[',
  'true',
  'false',
  ':'
])

/**
 * Risk level for a whole command string: `high` when any simple command is
 * high risk, `gray` when the parse fails or any simple command is unprovable,
 * `low` only when every simple command is statically read-only.
 *
 * @param {string} cmd
 * @returns {import('./types.js').StaticCommandLevel}
 */
export function classifyByStaticRules(cmd) {
  const commands = collectSimpleCommands(cmd)
  if (!commands || commands.length === 0) return 'gray'

  let sawGray = false
  for (const command of commands) {
    const risk = classifySimpleCommand(command)
    if (risk.level === 'high') return 'high'
    if (risk.level === 'gray') sawGray = true
  }
  return sawGray ? 'gray' : 'low'
}

/**
 * Public risk verdict: the level of the whole command plus the most useful verb
 * for a human summary. High risk always wins; then the first unprovable
 * command's verb; otherwise the first low-risk verb, preferring the
 * kubectl/docker/systemctl verb forms (same preference as `extractRiskVerb`).
 *
 * @param {string} cmd
 * @returns {{ level: import('./types.js').StaticCommandLevel, verb: string }}
 */
export function classifyCommand(cmd) {
  const commands = collectSimpleCommands(cmd)
  if (!commands || commands.length === 0) return { level: 'gray', verb: 'change' }

  let sawGray = false
  let grayVerb
  let firstLow
  let firstToolLow
  for (const command of commands) {
    const risk = classifySimpleCommand(command)
    if (risk.level === 'high') return { level: 'high', verb: risk.verb }
    if (risk.level === 'gray') {
      if (!sawGray) {
        sawGray = true
        grayVerb = risk.verb
      }
      continue
    }
    firstLow ??= risk.verb
    if (!firstToolLow && /^(kubectl|docker|systemctl)\b/.test(risk.verb)) {
      firstToolLow = risk.verb
    }
  }
  if (sawGray) return { level: 'gray', verb: grayVerb ?? 'change' }
  return { level: 'low', verb: firstToolLow ?? firstLow ?? 'change' }
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
export function hasHighWriteVerb(cmd) {
  return classifyByStaticRules(cmd) === 'high'
}

/**
 * @param {string} cmd
 * @returns {string}
 */
export function extractRiskVerb(cmd) {
  const commands = collectSimpleCommands(cmd)
  if (!commands || commands.length === 0) return 'change'

  let firstLow
  let firstToolLow
  for (const command of commands) {
    const risk = classifySimpleCommand(command)
    if (risk.level === 'high') return risk.verb
    if (risk.level !== 'low') continue
    firstLow ??= risk.verb
    if (!firstToolLow && /^(kubectl|docker|systemctl)\b/.test(risk.verb)) {
      firstToolLow = risk.verb
    }
  }
  return firstToolLow ?? firstLow ?? 'change'
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
export function isStaticallyReadonly(cmd) {
  return classifyByStaticRules(cmd) === 'low'
}

/** `$` and backticks expand outside single quotes. Awk `$1` inside `'...'` does not. */
/**
 * @param {string} raw
 * @returns {boolean}
 */
function hasUnquotedExpansion(raw) {
  let singleQuoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (singleQuoted) {
      if (ch === "'") singleQuoted = false
      continue
    }
    if (ch === "'") {
      singleQuoted = true
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '$' || ch === '`') return true
  }
  return false
}

/**
 * Classify one parsed simple command.
 *
 * @param {import('./shell-command.js').SimpleCommand} command
 * @returns {import('./types.js').SimpleCommandRisk}
 */
export function classifySimpleCommand(command) {
  if (command.redirects.some((redirect) => redirect.kind === 'file')) {
    return { level: 'high', verb: '>' }
  }

  if (['env', 'nohup', 'time'].includes(commandBasename(command.argv[0] ?? '')))
    return { level: 'gray', verb: 'environment/wrapper' }
  let argv = stripWrappers(command.argv)
  if (argv[0] === '!') argv = argv.slice(1)
  const argv0 = commandBasename(argv[0] ?? '')
  if (!argv0) return { level: 'gray', verb: 'change' }

  if (SHELL_NAMES.has(argv0)) {
    if (argv.length !== 3 || argv[1] !== '-c') return { level: 'gray', verb: argv0 }
    return classifyPeeledInner(argv, classifySimpleCommand)
  }
  if (argv0 === 'sudo') return classifyReadonlySudo(argv, classifySimpleCommand)

  if (hasUnquotedExpansion(command.raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.raw))
    return { level: 'gray', verb: argv0 }
  if (SIMPLE_WRITE.has(argv0)) return { level: 'high', verb: argv0 }

  if (argv0 === 'kubectl') return classifyKubectl(argv, classifySimpleCommand)

  if (argv0 === 'ssh') return classifySsh(argv, classifySimpleCommand)

  if (argv0 === 'docker') return classifyDocker(argv, classifySimpleCommand)

  if (argv0 === 'systemctl') return classifySystemctl(argv)

  if (argv0 === 'sed' && hasSedInPlace(argv)) return { level: 'high', verb: 'sed' }
  if (argv0 === 'sysctl' && isSysctlWrite(argv)) return { level: 'high', verb: 'sysctl' }
  if (argv0 === 'sysctl') return { level: 'low', verb: 'sysctl' }
  if (argv0 === 'find' && hasFindMutation(argv)) return { level: 'high', verb: 'find' }
  if ((argv0 === 'jq' && argv.includes('--in-place')) || (argv0 === 'yq' && hasYqInPlace(argv))) {
    return { level: 'high', verb: argv0 }
  }
  if (argv0 === 'yq') return { level: 'gray', verb: 'yq' }
  if (argv0 === 'curl') {
    return isReadonlyCurl(argv) ? { level: 'low', verb: 'curl' } : { level: 'gray', verb: 'curl' }
  }
  if (hasUnsafeInspectionArguments(argv0, argv)) return { level: 'gray', verb: argv0 }
  if (SIMPLE_READ.has(argv0)) return { level: 'low', verb: argv0 }
  return { level: 'gray', verb: argv0 }
}
