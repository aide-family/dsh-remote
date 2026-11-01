/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/inspection.ts
 */

/**
 * Read-only-looking inspection commands that can be turned into writes or
 * secret reads through arguments are reclassified as unsafe.
 *
 * @param {string} name lowercased command basename
 * @param {string[]} argv full argv including the command name
 * @returns {boolean}
 */
export function hasUnsafeInspectionArguments(name, argv) {
  const args = argv.slice(1)
  if (
    args.some((arg) =>
      /(?:^|\/)(?:shadow|gshadow|id_rsa|id_ed25519|credentials|\.env)(?:$|[./])/.test(arg)
    )
  )
    return true
  if (['env', 'printenv', 'awk', 'sed', 'yq'].includes(name)) return true
  if (name === 'find' && args.some((arg) => ['-fprint', '-fprintf', '-fls'].includes(arg)))
    return true
  if (name === 'sort' && args.some((arg) => /^(-o|--output|--compress-program)/.test(arg)))
    return true
  if (name === 'uniq' && args.filter((arg) => !arg.startsWith('-')).length > 1) return true
  if (name === 'ss' && args.some((arg) => ['-K', '--kill'].includes(arg))) return true
  if (name === 'shasum' && args.some((arg) => ['-c', '--check'].includes(arg))) return true
  if (
    name === 'jq' &&
    args.some((arg) => /^(-L|--argfile|--rawfile|--slurpfile|--from-file|-f)/.test(arg))
  )
    return true
  if (name === 'date' && args.some((arg) => /^(-s|--set)/.test(arg))) return true
  if (name === 'hostname' && args.some((arg) => !arg.startsWith('-'))) return true
  if (name === 'hostnamectl' && args.some((arg) => arg.startsWith('set-'))) return true
  if (
    name === 'ip' &&
    args.some((arg) => /^(add|del|delete|replace|change|set|flush|exec|netns|batch)$/.test(arg))
  )
    return true
  if (
    name === 'journalctl' &&
    args.some((arg) => /vacuum|rotate|flush|sync|setup-keys|update-catalog/.test(arg))
  )
    return true
  return false
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasSedInPlace(argv) {
  return argv
    .slice(1)
    .some((arg) => arg === '-i' || arg.startsWith('--in-place') || /^-i./.test(arg))
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
export function isSysctlWrite(argv) {
  return argv
    .slice(1)
    .some(
      (arg) =>
        arg === '-w' ||
        arg === '--write' ||
        arg === '-p' ||
        arg === '--system' ||
        arg.startsWith('--load') ||
        (/^[^=-]+=/.test(arg) && !arg.startsWith('-'))
    )
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasFindMutation(argv) {
  return argv.some(
    (arg) =>
      arg === '-delete' ||
      arg === '-exec' ||
      arg === '-ok' ||
      arg === '-execdir' ||
      arg === '-okdir'
  )
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasYqInPlace(argv) {
  return argv.includes('-i') || argv.includes('--inplace') || argv.includes('--in-place')
}

/**
 * Transport flags on curl cannot prove read-only semantics (an HTTP GET can
 * mutate state), so curl is never considered statically read-only.
 *
 * @param {string[]} _argv
 * @returns {boolean}
 */
export function isReadonlyCurl(_argv) {
  // HTTP GET endpoints can mutate state; transport flags cannot prove read-only semantics.
  return false
}
