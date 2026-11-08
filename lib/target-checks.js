import { randomBytes } from "node:crypto";
import { classifyCommand } from "./policy/index.js";
import { collectSimpleCommands } from "./policy/shell-command.js";

export const MAX_TARGET_CHECKS = 10;
export const MAX_TARGET_TEXT_BYTES = 4096;
export const MAX_TARGET_OUTPUT_BYTES = 256 * 1024;
const NONCE = /^[0-9a-f]{32}$/;
const failure = (message) => Object.assign(new Error(message), { code: "TARGET_CHECK_INVALID" });
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const bounded = (value, label, empty = false) => {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > MAX_TARGET_TEXT_BYTES || /[\0\r]/u.test(value)) throw failure(`${label} must be bounded text without NUL/CR`);
  return value;
};

export function normalizeTargetChecks(value, label = "targetChecks") {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TARGET_CHECKS) throw failure(`${label} must be an array of at most ${MAX_TARGET_CHECKS} checks`);
  const names = new Set();
  const commands = new Map();
  return value.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw failure(`${label}[${index}] must be an object`);
    if (Object.keys(input).some(key => !["name", "command", "expected"].includes(key))) throw failure(`${label}[${index}] contains unsupported fields`);
    const name = bounded(input.name, `${label}[${index}].name`).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) || names.has(name)) throw failure(`${label} names must be unique safe identifiers (max 80 characters)`);
    names.add(name);
    const command = bounded(input.command, `${label}[${index}].command`).trim();
    if (/[\n\x01-\x1f\x7f]/u.test(command)) throw failure(`${label}[${index}].command must be one printable line`);
    if (classifyCommand(command).level === "high") throw failure(`${label}[${index}].command is statically mutating; target checks must not mutate`);
    assertProbeContext(command);
    const expected = bounded(input.expected, `${label}[${index}].expected`).replace(/\n+$/u, "");
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(expected)) throw failure(`${label}[${index}].expected contains controls`);
    if (commands.has(command) && commands.get(command) !== expected) throw failure(`${label} has contradictory expectations for one command`);
    commands.set(command, expected);
    return { name, command, expected };
  });
}

/** Effective profile checks are a union, never a last-profile-wins override. */
export function composeTargetChecks(groups) {
  const checks = [];
  for (const group of groups) for (const check of normalizeTargetChecks(group)) {
    const same = checks.find(item => item.name === check.name || item.command === check.command);
    if (same) {
      if (same.command !== check.command || same.expected !== check.expected) throw failure("Matched target profiles contain contradictory checks");
      continue;
    }
    checks.push(check);
  }
  return normalizeTargetChecks(checks, "effective targetChecks");
}

/** Conservative opt-in context-override check; NOT a sandbox or full shell proof.
 * Callers must apply this before guarded actions, never to operator-owned probes.
 */
export function assertTargetCommandContext(command) {
  bounded(command, "guarded command");
  assertSimpleShell(command);
  const commands = collectSimpleCommands(command);
  if (!commands || !commands.length || /(^|[^&])&([^&]|$)/u.test(command)) throw failure("Cannot prove guarded command context from this shell syntax/background work");
  const switchers = new Set(["ssh", "scp", "sftp", "sh", "bash", "dash", "zsh", "fish", "eval", "exec", "sudo", "su", "env", "source", ".", "cd", "export", "unset", "xargs", "parallel", "nsenter", "chroot", "command", "builtin", "timeout", "time", "nohup", "nice", "stdbuf", "python", "python3", "node", "perl", "ruby"]);
  for (const simple of commands) {
    const argv = simple.argv;
    const executable = (argv[0] ?? "").split("/").at(-1);
    if (switchers.has(executable) || RESERVED_SHELL.has(executable) || /^\s*[A-Za-z_][A-Za-z0-9_]*=/u.test(simple.raw) || argv.some(arg => /[$`]/u.test(arg))) throw failure("Guarded command changes, dynamically expands, or nests its execution context");
    if (["kubectl", "docker", "systemctl", "journalctl"].includes(executable) && argv.some(arg => /^(?:--(?:context|kubeconfig|namespace|cluster|user|server|as|as-group|host|machine|root)(?:=|$)|-[nHsM](?:[^-]|$))/.test(arg))) throw failure("Guarded command explicitly overrides a checked CLI target");
    if (executable === "kubectl" && argv.some(arg => ["exec", "run", "debug", "config"].includes(arg))) throw failure("Guarded kubectl command changes or nests its checked context");
    if (executable === "docker" && argv.some(arg => ["exec", "run", "context"].includes(arg))) throw failure("Guarded docker command changes or nests its checked context");
  }
  return true;
}

const RESERVED_SHELL = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'select', 'function', 'coproc', 'return', 'break', 'continue', 'set', 'alias', 'unalias', 'declare', 'typeset', 'local', 'readonly', 'read', 'trap', 'enable', 'hash']);
function assertSimpleShell(command) {
  if (/[\x00-\x1f\x7f]/u.test(command)) throw failure('Guarded commands require a printable line');
  let quote = null, escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '`' || (char === '$' && ['(', '{'].includes(command[i + 1]))) throw failure('Shell expansion/compound context cannot be proven');
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (['(', ')', '{', '}', '`', '!'].includes(char) || (char === '$' && ['(', '{'].includes(command[i + 1]))) throw failure('Compound shell grammar/context cannot be proven');
  }
  if (quote || escaped) throw failure('Incomplete shell syntax');
}
function assertProbeContext(command) {
  assertSimpleShell(command);
  // A probe selecting another host/config cannot prove the action's ambient
  // context. Opaque operator CLIs remain trusted definitions, not attestation.
  const switchers = new Set(['ssh', 'scp', 'sftp', 'sudo', 'su', 'env', 'sh', 'bash', 'dash', 'zsh', 'fish', 'eval', 'exec', 'source', '.', 'cd', 'export', 'unset', 'nsenter', 'chroot', 'command', 'builtin', 'timeout', 'time', 'nohup', 'nice', 'stdbuf', 'xargs', 'parallel']);
  for (const simple of collectSimpleCommands(command) ?? []) {
    const executable = (simple.argv[0] ?? '').split('/').at(-1);
    if (switchers.has(executable) || RESERVED_SHELL.has(executable) || /[$`]/u.test(executable) || /^\s*[A-Za-z_][A-Za-z0-9_]*=/u.test(simple.raw)) throw failure('Target probe overrides its ambient execution context');
    if (['kubectl', 'docker', 'systemctl', 'journalctl'].includes(executable) && simple.argv.some(arg => /[$`]/u.test(arg))) throw failure('Target probe dynamically selects a CLI context');
    if (executable === 'kubectl' && simple.argv.includes('config') && !['current-context', 'view', 'get-contexts', 'get-clusters', 'get-users'].includes(simple.argv[simple.argv.indexOf('config') + 1])) throw failure('Target probe must not mutate kubectl configuration');
    if (executable === 'docker' && simple.argv.includes('context') && !['ls', 'inspect', 'show'].includes(simple.argv[simple.argv.indexOf('context') + 1])) throw failure('Target probe must not mutate Docker context');
    if (['kubectl', 'docker', 'systemctl', 'journalctl'].includes(executable) && simple.argv.some(arg => /^(?:--(?:context|kubeconfig|namespace|cluster|user|server|as|as-group|host|machine|root)(?:=|$)|-[nHsM](?:[^-]|$))/.test(arg))) {
      throw failure('Target probe explicitly selects a different CLI context');
    }
  }
}

const octal = text => [...Buffer.from(text)].map(byte => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
const evalText = text => `eval "$(printf '%b' ${quote(octal(text))})"`;
function validNonce(nonce) { if (!NONCE.test(nonce)) throw failure("Invalid target protocol nonce"); return nonce; }

/** One printable-line POSIX wrapper. Subshells retain current cwd/env/functions,
 * but intentionally do not persist action shell-state changes to the user's PTY.
 * od/tr/head are required remote utilities. Nonces defend accidental echo, not a
 * malicious operator-configured probe/action, which is not sandboxed here.
 */
export function buildTargetScript(checks, command, nonce = randomBytes(16).toString("hex")) {
  checks = normalizeTargetChecks(checks);
  validNonce(nonce);
  if (command !== undefined) {
    bounded(command, "guarded command");
    if (checks.length) assertTargetCommandContext(command);
  }
  const marker = `__DSH_RC_${nonce}`;
  const markerHex = Buffer.from(`\n${marker}:`).toString("hex");
  const statements = ["p=$(printf '%s%s%s' 'DSH_' 'TARGET_' " + quote(nonce) + ")", "printf '\\n%s|BEGIN\\n' \"$p\"", "state=passed", "action_rc=0",
    "if ! command -v head >/dev/null 2>&1 || ! command -v od >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1; then printf '%s|END|failed\\n' \"$p\"; return 125; fi"];
  for (const [index, check] of checks.entries()) {
    // Capture a bounded stream INCLUDING its producer exit marker. A missing
    // marker after truncation/exit means failure; pipeline head's status is not
    // misrepresented as the probe's exit status.
    // Hex BEFORE command substitution: shell variables cannot represent NUL,
    // so capturing raw stdout would silently erase bytes and permit false matches.
    statements.push(`cap=$( ( ${evalText(check.command)}; r=$?; printf '\\n%s:%03d' ${quote(marker)} "$r" ) | command head -c ${MAX_TARGET_TEXT_BYTES + 128} | command od -An -v -tx1 | command tr -d ' \\n')`);
    statements.push(`case "$cap" in *${markerHex}*) hrc=\${cap##*${markerHex}}; hex=\${cap%${markerHex}*};; *) hrc=''; hex='';; esac`);
    const digitCases = Array.from({ length: 10 }, (_, digit) => `3${digit}) r="\${r}${digit}";;`).join(" ");
    statements.push(`if [ "\${#hrc}" -ne 6 ]; then r=125; else r=''; while [ -n "$hrc" ]; do b=\${hrc%"\${hrc#??}"}; hrc=\${hrc#??}; case "$b" in ${digitCases} *) r=125; hrc='';; esac; done; r=\${r#0}; r=\${r#0}; fi`);
    statements.push(`if [ "$r" -gt 255 ] || [ "\${#hex}" -gt ${MAX_TARGET_TEXT_BYTES * 2} ]; then r=125; hex=''; fi`);
    statements.push("while [ \"${hex%0a}\" != \"$hex\" ]; do hex=${hex%0a}; done");
    statements.push(`printf '%s|CHECK|${index}|%s|%s\\n' "$p" "$r" "$hex"`);
    statements.push(`if [ "$r" -ne 0 ]; then state=failed; elif [ "$hex" != ${quote(Buffer.from(check.expected).toString("hex"))} ] && [ "$state" = passed ]; then state=mismatch; fi`);
  }
  if (command !== undefined) {
    statements.push(`if [ "$state" = passed ]; then printf '%s|ACTION_START\\n' "$p"; ( ${evalText(command)} ); action_rc=$?; printf '\\n%s|ACTION_EXIT|%s\\n' "$p" "$action_rc"; fi`);
  }
  statements.push("printf '%s|END|%s\\n' \"$p\" \"$state\"", "if [ \"$state\" != passed ]; then return 125; fi", "return \"$action_rc\"");
  // Nonce-private variable names avoid shadowing ambient variables used by
  // inherited operator functions. Replace shell references/assignments only,
  // never printf formats, encoded command bytes or protocol words.
  const variables = "p|state|action_rc|cap|hrc|hex|r|b";
  const privateName = name => `__dsh_${nonce}_${name}`;
  const body = statements.join("; ")
    .replace(new RegExp(`\\$\\{#(${variables})(?=\\})`, "g"), (_, name) => `\${#${privateName(name)}`)
    .replace(new RegExp(`\\$\\{(${variables})(?=[}:#%])`, "g"), (_, name) => `\${${privateName(name)}`)
    .replace(new RegExp(`\\$(${variables})\\b`, "g"), (_, name) => `$${privateName(name)}`)
    .replace(new RegExp(`(?<![A-Za-z0-9_])(${variables})=`, "g"), (_, name) => `${privateName(name)}=`);
  const script = `( dsh_target_${nonce}() { ${body}; }; dsh_target_${nonce} )`;
  if (/[\n\r]/.test(script)) throw failure("Target wrapper must be a single line");
  if (Buffer.byteLength(script) > 65_536) throw failure("Combined target wrapper exceeds 64 KiB; shorten checks/action");
  return { command: script, nonce };
}

export function targetOutputComplete(output, nonce) {
  if (!NONCE.test(nonce) || typeof output !== "string" || Buffer.byteLength(output) > MAX_TARGET_OUTPUT_BYTES) return false;
  return new RegExp(`(?:^|\\n)DSH_TARGET_${nonce}\\|END\\|(passed|mismatch|failed)\\n`).test(output.replaceAll("\r\n", "\n"));
}

export function parseTargetOutput(output, nonce, checks) {
  checks = normalizeTargetChecks(checks);
  const unknown = () => ({ status: "unknown", checks: checks.map(check => ({ name: check.name, expected: check.expected, status: "unknown" })), actionExecuted: null, actionOutput: "" });
  if (!NONCE.test(nonce) || typeof output !== "string" || Buffer.byteLength(output) > MAX_TARGET_OUTPUT_BYTES) return unknown();
  const prefix = `DSH_TARGET_${nonce}|`;
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  const frameLines = lines.slice(0, -1).map((line, index) => ({ line, index })).filter(item => item.line.startsWith(prefix));
  const frames = frameLines.map(item => item.line.slice(prefix.length));
  if (frames[0] !== "BEGIN") return unknown();
  let cursor = 1;
  const results = [];
  for (const [index, check] of checks.entries()) {
    const match = new RegExp(`^CHECK\\|${index}\\|([0-9]{1,3})\\|([0-9a-f]*)$`).exec(frames[cursor++]);
    if (!match || Number(match[1]) > 255 || match[2].length % 2 || match[2].length > MAX_TARGET_TEXT_BYTES * 8) return unknown();
    const bytes = Buffer.from(match[2], "hex");
    const actual = bytes.toString("utf8");
    if (!Buffer.from(actual).equals(bytes)) return unknown();
    const exitCode = Number(match[1]);
    results.push({ name: check.name, expected: check.expected, actual, exitCode, status: exitCode !== 0 ? "failed" : actual === check.expected ? "passed" : "mismatch" });
  }
  const status = results.some(check => check.status === "failed") ? "failed" : results.some(check => check.status === "mismatch") ? "mismatch" : "passed";
  let exitCode;
  let actionExecuted = false;
  let actionOutput = "";
  if (frames[cursor] === "ACTION_START") {
    if (status !== "passed") return unknown();
    actionExecuted = true;
    const startLine = frameLines[cursor].index;
    const match = /^ACTION_EXIT\|([0-9]{1,3})$/.exec(frames[++cursor]);
    actionOutput = lines.slice(startLine + 1, frameLines[cursor]?.index ?? startLine + 1).join("\n");
    if (!match || Number(match[1]) > 255) return unknown();
    exitCode = Number(match[1]); cursor++;
  }
  if (frames[cursor++] !== `END|${status}` || cursor !== frames.length) return unknown();
  return { status, checks: results, ...(exitCode === undefined ? {} : { exitCode }), actionExecuted, actionOutput };
}
