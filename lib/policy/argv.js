/**
 * Ported from the Crescent project (aide-family/Crescent), src/shared/command-policy/argv.ts
 */

/**
 * Index of the first non-flag token (starting at argv[1]) that equals `verb`.
 * Stops at `--`. Returns -1 when absent.
 *
 * @param {string[]} argv
 * @param {string} verb
 * @returns {number}
 */
export function findVerbIndex(argv, verb) {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '--') break
    if (token.startsWith('-')) continue
    if (token.toLowerCase() === verb) return i
  }
  return -1
}

/**
 * First known subcommand verb after any leading global flags.
 *
 * @param {string[]} argv
 * @param {Set<string>} write
 * @param {Set<string>} read
 * @returns {string | undefined}
 */
export function firstKnownVerb(argv, write, read) {
  const valued = new Set([
    '-n',
    '--namespace',
    '--context',
    '--kubeconfig',
    '--server',
    '-s',
    '--as',
    '--as-group',
    '--request-timeout',
    '--field-selector',
    '--selector',
    '-l',
    '--type',
    '-t',
    '--state',
    '--property',
    '-p',
    '--host',
    '-H',
    '--machine',
    '-M'
  ])
  let i = 1
  while (i < argv.length && argv[i].startsWith('-')) {
    const flag = argv[i++]
    if (valued.has(flag)) i++
    else if (
      !flag.includes('=') &&
      ![
        '--no-pager',
        '--no-legend',
        '--plain',
        '--all',
        '-a',
        '--user',
        '--system',
        '--quiet',
        '-q'
      ].includes(flag)
    )
      return undefined
  }
  const verb = argv[i]
  return write.has(verb) || read.has(verb) ? verb : undefined
}
