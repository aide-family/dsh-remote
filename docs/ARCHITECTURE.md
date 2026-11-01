# dsh-remote — architecture & module contracts

`dsh-remote` is a DeepSeek Harness (DSH) plugin that lets the agent operate remote
servers over SSH. It is modeled on the Crescent operations workbench
(`/Users/hubiao/aide-family/Crescent`): hosts come from `~/.ssh/config` plus a
configured host list, commands run through an SSH transport, and risky commands
go through a static command-risk review before a human approval gate.

Package: ESM JavaScript, no build step (plain `.js` + JSDoc types). Node >= 22.
Tests: `node --test` (unit) and the fixture SSH server (integration).

## Non-negotiable conventions

- ESM only: `import` / `export`, `type: "module"`. No TypeScript, no bundler.
- Runtime deps: only `ssh2`. DSH host packages (`@deepseek-ai/*`) are imported
  only by `lib/index.js`/`lib/tools.js` and only when the plugin runs inside DSH.
  Pure modules (`lib/ssh/*`, `lib/policy/**`, `lib/hosts.js`, `lib/ssh-config.js`,
  `lib/config.js`) must not import any `@deepseek-ai/*` package so unit tests run
  without DSH.
- Never write outside `/Users/hubiao/aide-family` during development.
- Keep each file focused; target < 700 lines; split rather than grow.
- No secrets in output: passwords/passphrases only ever come from environment
  variables named in config; never echo their values.
- All remote output must be bounded (default 200 000 bytes) with an explicit
  truncation marker; all network operations must accept an `AbortSignal` and
  settle (close channel / socket) when it aborts.

## Package layout and ownership

| Path | Owner | Purpose |
| --- | --- | --- |
| `package.json`, `cordis.patch.yml` | lead | package manifest + DSH bundle patch |
| `lib/index.js` | lead | plugin entry: Config, apply, wiring, prompt, approval |
| `lib/tools.js`, `lib/render.js` | tools | `defineTool` definitions + result rendering |
| `lib/config.js` | hosts | Schemastery `Config` schema + normalization/defaults |
| `lib/hosts.js`, `lib/ssh-config.js` | hosts | host discovery/merge/resolution, `~/.ssh/config` parser |
| `lib/ssh/*` | transport | ssh2 pool, auth, exec, SFTP primitives, host-key policy |
| `lib/policy/**` | policy | ported Crescent static command-risk classifier |
| `test/fixtures/ssh-server.mjs` | transport | real SSH server fixture (password + key auth, exec + SFTP) |
| `test/unit/*.test.mjs` | each owner | node:test unit tests |
| `test/integration/*.test.mjs` | lead/tools | plugin-level tests: fake ctx + fixture server |
| `scripts/*` | lead | dev profile sync, e2e, packaging |
| `README.md` | lead | user docs (install, config, tools, security) |

Nobody edits another owner's files. Cross-module needs go through the contracts
below; if a contract must change, the Lead updates this document first.

## Host object (the single currency of all modules)

```js
/**
 * @typedef {object} RemoteHost
 * @property {string} id          stable id: "ssh-config:<name>" or "config:<name>"
 * @property {string} name        lookup name the model uses (no spaces)
 * @property {string} host        hostname/IP to connect to
 * @property {number} [port]      1-65535, default 22
 * @property {string} [username]  login user (from config/ssh config/process user)
 * @property {"ssh-config"|"config"} source
 * @property {string} [identityFile]  private key path, `~` allowed (ssh-config source only)
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {boolean} [readonly]   resolved per config `readonlyHosts` globs
 * @property {string[]} [proxyJump] proxy jump chain, `user@host[:port]` entries
 * @property {string} [passwordEnv] env-var NAME holding the password (config hosts only)
 * @property {string} [passphraseEnv] env-var NAME holding the key passphrase (config hosts only)
 */
```

Configured hosts (plugin config `hosts[]`) carry auth references, not secrets:

```js
{
  name: "prod-web-1",          // required, unique, lookup name
  host: "10.0.0.11",           // required
  port: 22,
  username: "ops",
  identityFile: "~/.ssh/prod_ed25519", // optional
  passwordEnv: "PROD_WEB_PASSWORD",    // optional env var NAME, never a value
  passphraseEnv: "PROD_KEY_PASSPHRASE",// optional env var NAME
  proxyJump: ["bastion.example.com"],  // optional
  tags: ["prod", "web"],
  description: "primary web node"
}
```

Auth resolution order inside transport (first that applies wins):

1. `passwordEnv` set and the env var is non-empty → password auth.
2. `identityFile` (config or ssh-config) → publickey auth with that key (optional
   passphrase from `passphraseEnv`).
3. `SSH_AUTH_SOCK` present → ssh-agent auth.
4. default keys: `~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, `~/.ssh/id_rsa` when
   readable → publickey auth.

Host-key policy (`config.knownHostsPolicy`): `"tofu"` (default; trust and persist
the first key under `$DSH_HOME/remote/known-hosts.json`), `"strict"` (reject
unknown keys), `"insecure"` (accept any key; result carries a warning).

## Transport contract — `lib/ssh/transport.js`

```js
import { createSshTransport } from "./ssh/transport.js";
const transport = createSshTransport({ connectTimeoutMs, idleMs, knownHostsPolicy, knownHostsPath, logger });
```

Methods (all async unless noted):

- `transport.exec(host, options)` → `ExecResult`
  - options: `{ command, workdir?, timeoutMs?, maxBytes?, signal?, pty? }`
  - `ExecResult`: `{ code, signal, stdout, stderr, stdoutBytes, stderrBytes, truncated, timedOut, durationMs }`
  - `code` is the remote exit code (`-1` when killed before exit). Non-zero exit
    is NOT an exception. Timeout aborts with `timedOut: true` and partial output.
    `maxBytes` caps each stream (tail kept), `truncated` set when cut.
    `AbortSignal` abort → reject with `AbortError` (`error.name === "AbortError"`).
    `workdir` is applied by running `cd <quoted workdir> && <command>`.
- `transport.test(host, { signal, timeoutMs? })` → `{ ok, latencyMs, error? }`
  (connect + banner; never throws for connection failures).
- `transport.withSftp(host, fn, { signal? })` → `T` where `fn(sftp, host)` does
  SFTP work. Serialized per host; retries once on channel/connection failure.
- `transport.readFile(host, path, { maxBytes, signal })` →
  `{ content:Buffer, size, truncated }`
- `transport.writeFile(host, path, content, { mode?, createDirs?, signal })` →
  `{ bytesWritten }` (atomic: temp file in the same dir + rename; `createDirs`
  creates missing parents)
- `transport.stat(host, path, { signal })` → `{ type: "file"|"dir"|"symlink"|"other", size, mtimeMs, mode }`
  (throws `RemoteFsError` with `code === "ENOENT"` when absent)
- `transport.listDir(host, path, { signal })` → `[{ name, type, size, mtimeMs, mode }]`
- `transport.mkdirp(host, path, { signal })`
- `transport.chmod(host, path, mode, { signal })`
- `transport.dispose()` — closes pooled connections (idempotent)

All remote-path failures throw `RemoteFsError` (`error.code`: `"ENOENT"`,
`"EACCES"`, `"ENOTDIR"`, `"EISDIR"`, `"SFTP_ERROR"`, `"CONNECTION"`; message
includes the SFTP code when present). Connection errors throw `SshError`
(`code`: `"AUTH"`, `"CONNECT"`, `"TIMEOUT"`, `"HOST_KEY"`).

Pool: one `ssh2.Client` per `host.id` + auth fingerprint, idle close after
`idleMs` (default 60 000), channel-per-exec, SFTP channel per `withSftp` call,
operations per host serialized. A dead pooled client is discarded and one
retry is allowed for a fresh connection on channel-level failures.

## Policy contract — `lib/policy/index.js`

Ported from Crescent `src/shared/command-guard.ts` + `src/shared/command-policy/*`
+ `src/shared/shell-command.ts`. Pure, synchronous, no I/O.

```js
import { classifyCommand, isStaticallyReadonly, extractRiskVerb } from "./policy/index.js";
classifyCommand(command)
```

- `classifyCommand(command)` → `{ level: "low"|"gray"|"high", verb: string }`
  - `low` — statically read-only (ls, cat, grep, kubectl get, docker ps, …)
  - `gray` — unknown/needs review (unknown binaries, pipelines it cannot prove,
    shell wrappers it cannot peel)
  - `high` — clearly mutating/destructive (rm, mv, dd, kill, systemctl
    restart/stop, kubectl delete/apply/patch, docker rm/restart/run, tee, chmod,
    chown, …)
- `isStaticallyReadonly(command)` → `boolean` (=== `level === "low"`)
- `hasHighWriteVerb(command)` → `boolean` (=== `level === "high"`)
- `extractRiskVerb(command)` → `string` — best verb for a human summary.

The classifier must handle: `&&`/`||`/`;`/`|`/`(`/`)` lists, redirections,
`sudo`, `env`/`nohup`/`time`/`command`/`xargs` wrappers, `sh -c '…'`,
`kubectl`/`docker`/`systemctl`/`journalctl` subcommands, `ssh` inner commands,
`find -exec`/`-delete`, `sed -i`, `yq -i`, `tee`, `sysctl -w`, `chmod/chown`,
`curl -X POST`-style writes. Anything unparsable is `gray`.

## Hosts contract — `lib/hosts.js`, `lib/ssh-config.js`, `lib/config.js`

```js
import { Config } from "./config.js";
import { loadHosts, findHost, isHostAllowed, isHostReadonly } from "./hosts.js";
const hosts = await loadHosts(config);           // RemoteHost[], sorted by name
findHost(hosts, "prod-web-1")                   // RemoteHost | undefined
isHostAllowed(host, config)                      // allowHosts glob match (empty = all)
isHostReadonly(host, config)                     // readonlyHosts glob match (force-readonly)
```

- `lib/ssh-config.js` — `loadSshConfig(filePath, { homeDir })` handles `Host`
  blocks with multiple aliases, `Include` (relative to `~/.ssh` and absolute,
  recursive with depth guard), `HostName/User/Port/IdentityFile/ProxyJump`,
  comments, quoted values, case-insensitive keys; skips pattern aliases
  (`*`, `?`, `!`) but uses their `Host` blocks only as "cannot resolve".
- `lib/hosts.js` — merges ssh-config hosts with `config.hosts` (config wins on
  name conflict), applies `readonlyHosts`/`allowHosts`, drops entries without a
  hostname, dedupes, sorts. `loadHosts` must read the ssh config once per call
  and tolerate a missing/unreadable file (return `[]` + warning, never throw).
- `lib/config.js` — exports `Config` (Schemastery) and `normalizeConfig(raw)`.
  Config fields:

```js
{
  hosts: [],                       // array of configured host objects
  includeSshConfig: true,          // read ~/.ssh/config hosts
  sshConfigPath: "~/.ssh/config",
  policy: "auto",                  // "auto" | "always" | "never" (approval policy)
  readonlyHosts: [],               // globs: mutating actions denied
  allowHosts: [],                  // globs: only these hosts usable (empty = all)
  denyCommandPatterns: [],         // RegExp sources: remote_exec denied outright
  connectTimeoutMs: 20000,
  execTimeoutMs: 120000,
  maxOutputBytes: 200000,
  maxReadBytes: 800000,            // remote_read file cap
  maxTransferBytes: 52428800,      // upload/download cap
  knownHostsPolicy: "tofu",        // "tofu" | "strict" | "insecure"
  allowLocalOutsideWorkspace: false, // remote_transfer local paths outside the session workspace
  promptGuidance: true             // contribute the system-prompt section
}
```

Schemastery conventions: `Schema.object({...})`, `Schema.string().default(...)`,
`Schema.natural()`, `Schema.array(Schema.object({...}))`, `Schema.union([...])`,
`.description(...)`. Defaults must make `apply(ctx)` work with no config block.

## Tool surface — `lib/tools.js`

All tools are defined with `defineTool` from `@deepseek-ai/dsh-tools` and take a
`deps` object created by `lib/index.js`:

```js
createTools({ defines: { defineTool }, config, hosts, transport, policy, approval, cwdOf })
```

| Tool | Args | Mutating | Approval |
| --- | --- | --- | --- |
| `remote_hosts` | `{ all?: boolean }` | no | never |
| `remote_probe` | `{ host }` | no | never |
| `remote_exec` | `{ description, host, command, workdir?, timeout_ms? }` | per classifier | auto: level != low; always: yes; never: deny non-low |
| `remote_read` | `{ host, path, offset?, limit? }` | no | never |
| `remote_list` | `{ host, path }` | no | never |
| `remote_write` | `{ host, path, content, create_dirs? }` | yes | auto/always: yes; never: deny |
| `remote_edit` | `{ host, path, old_string, new_string, replace_all? }` | yes | auto/always: yes; never: deny |
| `remote_transfer` | `{ description, host, direction, local_path, remote_path, overwrite? }` | yes | auto/always: yes; never: deny |

Behavior requirements:

- Every tool resolves `host` via `findHost`; unknown host → error listing
  available names (bounded, e.g. first 20). Disallowed host (allowHosts) → error.
- Read-only tools on a `readonly`/allowed host always work (still bounded).
- Mutating tools on a readonly host → deny with a clear reason; on approval
  policy `never` → deny with a clear reason; on `ask`-style policy → call
  `approval.request` (see below). Approval outcome `allowed-once` = proceed;
  `rejected` = deny with "rejected by user"; `cancelled` = deny "cancelled";
  `unavailable` = deny "approval unavailable (fail closed)".
- Approval request shape: `approval.request({ agent: exec.agent, toolName, callId: exec.callId, reason, signal: exec.signal })`.
  Reason is a short, specific sentence: action, host name + `user@host:port`,
  the exact command (truncated to ~300 chars) or path, and the risk verb.
- `remote_exec` output: exit code line `[exit code: N]`, stdout, then `[stderr]`
  section when non-empty, then optional markers (`[output truncated …]`,
  `[timeout after Nms]`, `[no output]`). Non-zero exit is a normal result.
- `remote_read` returns line-numbered text (`1→…` style is fine: `<n>: <line>`),
  truncates to `maxReadBytes`, and appends `[truncated; next offset: N]` so the
  model can continue. Report line count and byte size in the header line.
- `remote_write`/`remote_edit` report path, bytes, and (edit) number of
  replacements; `remote_edit` must read-before-write, fail on 0 matches or >1
  matches without `replace_all`, and preserve the file mode.
- `remote_transfer`: `direction: "upload"` copies local→remote, `"download"`
  remote→local. `local_path` is resolved against the session cwd (provided by
  `cwdOf(exec)`) and must stay inside the session workspace unless
  `config.allowLocalOutsideWorkspace` is true; `remote_path` supports `~`.
  Refuse to overwrite an existing remote file unless `overwrite: true`.
- Every `execute` must honor `exec.signal` and dispose/close what it opened;
  prefer polling aborts for SFTP transfers.
- `render.js` maps structured canonical values to model text so tests can assert
  on strings; content must be deterministic (no timestamps unless they are facts
  from the remote side).

System prompt section (in `lib/index.js`, order 1005): explains that the tools
operate real remote servers, host discovery, which tools are read-only, that
mutating actions need approval and may fail closed, that commands are
non-interactive one-shot (no PTY), and to prefer `remote_read`/`remote_list`
over `cat`/`ls`, check exit codes, and never paste credentials.

## DSH integration facts (verified in this environment)

- Plugin bundle patch (`cordis.patch.yml`): `- insert: [{ id: dsh-remote, name: dsh-remote }]`.
- Entry module exports `{ name, Config?, inject, apply }` (Cordis plugin).
- `inject: ["tools", "systemPrompt"]`; approval is optional via `ctx.get("approval")`.
- `ctx.tools.register(defineTool({...}))`, `ctx.systemPrompt.section({ name, order, text })`.
- `ctx.effect(() => () => transport.dispose())` for teardown.
- Local development install: the package must physically live inside
  `<profile>/node_modules/dsh-remote` (a `link:`/symlink outside the profile
  cannot resolve `@deepseek-ai/*` imports). Use the tarball install
  (`dsh plugin --profile <p> add file:/abs/path/dsh-remote-<v>.tgz`) or
  `scripts/sync-profile.sh` for the dev loop.
- Dev/e2e harness: `DSH_HOME=/Users/hubiao/aide-family/.dsh-test`,
  profile `remotedev` (headless template, credentials taken from
  `~/.dsh/.credentials.yaml` via symlink), run:
  `DSH_HOME=... dsh --profile remotedev "prompt"`.

## Test strategy

1. Unit (`test/unit/*.test.mjs`): ssh-config parser, host merge, config
   defaults, policy classifier vectors, known-hosts TOFU.
2. Integration (`test/integration/*.test.mjs`): start `test/fixtures/ssh-server.mjs`
   (real ssh2 Server on 127.0.0.1:0; password + key auth; commands run through a
   local `/bin/sh -c` in a temp dir; SFTP served from the same temp dir), then
   `apply()` the plugin with a fake ctx (`tools.register`, `systemPrompt.section`,
   `approval`, `effect`), execute handlers directly with fake `exec`
   (`{ agent: { id: "test" }, signal, callId: "call-1" }`), assert results and
   approval outcomes for allowed/rejected/unavailable policies.
3. E2E (`scripts/e2e.sh`): sync into the `remotedev` DSH profile, run a few
   headless prompts (`dsh --profile remotedev "…"`), assert the model used the
   tools correctly (read-only exec works; mutating exec fails closed in headless).

## Addendum (Lead, after initial contracts)

### `transport.homeDir`

`transport.homeDir(host, { signal?, timeoutMs? })` → remote user's home directory
(cached per pooled connection). Tools use it to expand `~/…` for remote paths.

### `createTools` contract (lib/tools.js)

`lib/index.js` imports:

```js
import { createTools } from "./tools.js";
const tools = createTools({ defineTool, config, transport, hosts, approval, cwdOf, logger });
for (const tool of tools) ctx.tools.register(tool);
```

- `defineTool` — the `@deepseek-ai/dsh-tools` factory.
- `config` — normalized config (see `lib/config.js`).
- `transport` — the transport contract above.
- `hosts` — `{ list({refresh}), find(query), isAllowed(host), isReadonly(host) }`
  (from `lib/host-store.js`).
- `approval` — `{ assessCommand(command), authorize({ toolName, exec, host, action, subject, mutating, verb, description, readonlyHost }) }`
  (from `lib/approval.js`); `authorize` returns `{ allowed, reason?, outcome? }`.
- `cwdOf(exec)` → `Promise<string>` session working directory (absolute).

Tools are returned as plain ToolDefinitions; `createTools` must not import
`@deepseek-ai/*` directly except the injected `defineTool` (so tests can inject a
stub). `lib/render.js` maps canonical result values to `[{type:"text", text}]`.

Canonical values (used by render.js and asserted by tests):

- `remote_hosts` → `{ total, hosts: [{ name, host, port, username, source, description?, tags?, readonly, authHint }] }`
- `remote_probe` → `{ host, ok, latencyMs, banner?, info?: { hostname, user, os, kernel, uptime, load, memory, diskRoot }, warnings: string[] }`
- `remote_exec` → `{ host, command, exitCode, signal, stdout, stderr, truncated, timedOut, durationMs }`
- `remote_read` → `{ host, path, content, lineCount, offset, limit, size, truncated, nextOffset? }`
- `remote_list` → `{ host, path, total, entries: [{ name, type, size, mtimeMs, mode }] }`
- `remote_write` → `{ host, path, bytesWritten, created, mode? }`
- `remote_edit` → `{ host, path, replacements, bytesWritten }`
- `remote_transfer` → `{ host, direction, localPath, remotePath, bytes, durationMs }`

Error policy: user/policy denials and invalid input throw `Error` with a clear
message (tool failure, visible as an error result); connection/file failures
also throw with the underlying `error.code` in the message. No secrets are ever
placed in results.

## Implementation notes (post-build, as verified)

These are the deliberate deltas from the first contract draft. All are additive
or compatible; the full suite and the headless e2e agree with them.

### Transport (`lib/ssh/**`)

- `transport.homeDir(host, {signal, timeoutMs})` resolves the remote home once
  per pooled connection (SFTP `REALPATH "."`, with an exec `printf %s "$HOME"`
  fallback) and is cached.
- Additive result fields: `warning?` on `test()`/`exec()`, `modeString` on
  `stat`/`listDir` entries, `target` on symlink `stat`, and `poolSize` /
  `isDisposed` diagnostics on the transport.
- `createSshTransport` also accepts optional `execTimeoutMs`, `maxOutputBytes`,
  `maxReadBytes`, and (tests only) `env`/`homeDir`/`fs` — `lib/index.js` passes
  only the documented five options.
- `idleMs` semantics: `0` closes after each operation, negative disables idle
  closing, default 60 000 ms with unref'd timers.
- ProxyJump: single hop, `string[]` first entry; extra hops log a warning and
  are ignored. Hop auth reuses the target host's auth references.
- No keepalive pings: a silently dead pooled socket is detected by the next
  operation and retried once on a fresh connection.
- Wrong key passphrase maps to `SshError` code `AUTH` (not `CONNECT`).

### Approval (`lib/approval.js`)

- The read-only-host guard applies only to mutating actions
  (`readonlyHost === true && mutating`), so read tools and low-risk exec still
  work on a read-only host.
- `denyCommandPatterns` are compiled once at load (invalid sources warn and are
  skipped); the denial itself is enforced by `lib/tools.js` before approval, so
  a denied command never reaches the approval seam.

### Tools (`lib/tools.js`, `lib/render.js`)

- `remote_hosts` lists only allowHosts-permitted hosts by default; `all: true`
  also lists blocked hosts (marked `allowed: false`). It does not refresh the
  host cache.
- Canonical values keep the documented shape plus additive fields:
  `remote_hosts.blocked`/`discovered`; `remote_write.mode` when a mode was
  preserved; `remote_read.nextOffset` only when more content follows;
  `remote_list` caps at 2 000 entries while `total` is the real count.
- `remote_write.create_dirs` defaults to `false`; `remote_transfer` never
  creates remote parent directories.
- Workspace containment for transfers is lexical against the session cwd (no
  realpath/symlink resolution); `allowLocalOutsideWorkspace: true` skips the
  check.
- `remote_read` paging is bounded by `maxReadBytes`: `offset`/`limit` page
  within the read window, and files larger than the cap must be handled with
  `remote_exec` (tail/grep/sed -n) or `remote_transfer`.

### Verification performed

- `node --test test/unit/*.test.mjs test/integration/*.test.mjs` → **545 tests,
  545 pass** (parser, policy, config, hosts, known-hosts, ssh transport incl.
  interactive PTY, remote tools, shell tools/manager/scrollback, audit log,
  management HTTP API, and real-fixture plugin integration tests).
- `node scripts/e2e.mjs` → **PASSED** against the real DSH headless profile:
  plugin load through the bundle patch, model-driven `remote_hosts`,
  `remote_exec` (read-only, `[exit code: 0]`), `remote_read` content, and a
  mutating `remote_exec` denied fail-closed without an answerer, and a full
  persistent-shell cycle (`remote_shell_open` → `remote_shell_send` →
  `remote_shell_close`) echoed real PTY output.
- The same e2e passes with `E2E_SKIP_SYNC=1` + `DSH_TEST_PROFILE=tarballtest`
  against a `dsh plugin add file:…tgz --ignore-scripts` install, which proves
  the packaged artifact resolves its DSH peers without the devDependencies.
- Live check in the running Desktop session after install:
  `remote_hosts` listed the two `~/.ssh/config` hosts, `remote_probe` returned
  hostname/OS/kernel/uptime/memory/disk for a real host, and a read-only
  `remote_exec` (`df -h / && free -h && hostname`) returned `[exit code: 0]`
  with the real output.

## Remote PTY terminals (v0.2)

The desktop "Persistent terminals" bundle (which mounts `ctx.terminals`) is
**off by default** in Web/Desktop and absent from the headless profile, so the
remote-shell surface must not depend on it. `dsh-remote` therefore owns a small
owner-scoped PTY session manager built on the transport's PTY channel, and
registers six model-facing tools. If a composition later mounts `ctx.terminals`,
a follow-up can bridge the manager to that service without changing the tools.

### Transport contract addition — interactive PTY channel

`transport.openPty(host, options)` → `Promise<PtySession>`

- options: `{ term?: string (default "xterm-256color"), cols?: number (120), rows?: number (40), signal? }`
- `PtySession`:
  - `write(data: string): void` — UTF-8 text to the remote shell (throws when closed)
  - `resize(cols: number, rows: number): void` — window-change request (best effort)
  - `signal(name: "INT"|"TERM"|"KILL"|"TSTP"|"HUP"): void` — ssh2 channel signal; INT
    falls back to writing `"\x03"` when the server ignores channel signals
  - `onData(cb: (text: string) => void): () => void` — decoded output chunks
  - `onExit(cb: (info: { code: number | null, signal: string | null }) => void): () => void` — once
  - `status(): { kind: "running" } | { kind: "exited", exitCode: number | null, signal: string | null }`
  - `close(reason?: string): Promise<void>` — close the channel only (the pooled
    connection stays), idempotent, waits for the close event.

Implementation: pooled `ssh2` client → `client.shell({ rows, cols, term })`; the
requested PTY is `xterm-256color` so the remote shell is interactive; aborting
`signal` before the channel opens rejects with `AbortError`.
Fixture: the ssh2 test server must also serve `shell` channels — allocate a PTY
for the requested window, spawn `/bin/sh -i` in `rootDir` (`HOME=rootDir`,
`TERM` from the request), forward channel data both ways, apply window-change to
the PTY, deliver signal requests to the child, and kill the child when the
channel closes.

### `lib/terminal/**` (terminal owner)

- `scrollback.js` — streaming sanitizer + bounded ring:
  - strips CSI/OSC/other ESC sequences, applies `\r` (line overwrite), `\b`, and
    `\t`; `\r\n` and `\n` end lines; partial lines are retained;
  - ring bounded by `terminalScrollbackLines` and `terminalScrollbackBytes`
    (oldest dropped first, `truncated` counter), UTF-8/code-point safe;
  - API: `append(text)`, `snapshot({ offset?, count?, maxBytes? })` returning
    `{ text, totalLines, lineBegin, lineEnd, truncated }` with newest-relative
    offsets (0 = newest line), `clearContents()`.
- `pty-session.js` — one remote shell session:
  - constructor wraps `PtySession` + scrollback + config;
  - startup: collect output until silence (`terminalIdleSilenceMs`) with a floor
    of ~250 ms and the `terminalStartupTimeoutMs` deadline, then publish `motd`
    (bounded, sanitized); channel exit during startup rejects the open;
  - `startSend({ text, submit, signal })` → operation `{ done, readOutput, cancel }`:
    writes `text` (+ `"\r"` when submit); settles when (a) the channel exits →
    `session_exit`, (b) output has been silent for `terminalIdleSilenceMs` after
    the write → `inferred_idle`, or (c) `terminalTimeoutMs` → `timeout`; returns
    `{ viewport: <bounded delta>, waitReason, sessionStatus, truncated }`;
    only one send may be active per session; `cancel()` delivers INT;
  - `read({ offset, count })` → scrollback page; `signal(name)` → transport
    signal, `{ delivered: true, targetPgid: 0 }` (the remote PID is unknown over
    the SSH channel); `status()`; `close(reason)`.
- `manager.js` — owner-scoped registry:
  - `createShellManager({ ctx, transport, config, logger })` returns
    `{ open, send, read, signal, close, list, dispose }`;
  - sessions are keyed by manager-minted id `remote-shell-<n>` and owned by the
    exact `Agent` object; operations by another agent fail with `FOREIGN_SESSION`;
  - `open` resolves the host via the host store and rejects disallowed/
    read-only-policy hosts before opening;
  - `ctx.on("agent/disposed", …)` closes that agent's sessions; `ctx.effect`
    disposes all sessions; disposal is quiescent (await close).

### Tools (Lead) — `lib/terminal/tools.js`

| Tool | Args | Mutating | Behaviour |
| --- | --- | --- | --- |
| `remote_shell_open` | `{ host, cwd? }` | no | Open a persistent PTY session; returns sessionId, host, status, motd. Denied for allowHosts-blocked hosts. |
| `remote_shell_send` | `{ sessionId, text, submit? }` | per classifier | Send text (Enter default true) and wait for idle/timeout/exit; output delta + wait reason. When `submit` is true, classify the text like a command: mutating/unknown needs approval; read-only runs; `never` denies mutating; read-only hosts deny mutating. `submit: false` (raw control input) is allowed. |
| `remote_shell_read` | `{ sessionId, offset?, count? }` | no | Bounded scrollback page (newest-relative). |
| `remote_shell_signal` | `{ sessionId, signal }` | yes | INT/TERM/KILL/TSTP/HUP; approval under auto/always, denied under never/readonly hosts. |
| `remote_shell_close` | `{ sessionId }` | no | Close session and await teardown. |
| `remote_shell_list` | `{}` | no | Owner's live sessions. |

All six only register when `config.terminalEnabled` is true; they are registered
by `lib/index.js` with the manager, approval gate, and cwd resolver. Prompt
section explains: sessions are remote, persistent, line-oriented (no full-screen
TUI), sends are bounded, one send at a time, close when done.

### User-facing live terminal pane (docs only)

DSH's right-sidebar user terminal runs a configured shell profile
(`api-terminal-controller` config `shell: {path, name, args}`). `scripts/dsh-remote-shell`
is an interactive host picker that `ssh -t`s to a chosen `~/.ssh/config` host, so
a user can make the sidebar terminal a live remote terminal with one profile
patch (documented in README; not enabled automatically).

### Terminal implementation notes (v0.2, as verified)

- **Readiness is output silence only.** An SSH shell channel exposes no remote
  foreground process group, so a send settles as `inferred_idle` after
  `terminalIdleSilenceMs` of silence, as `timeout` at `terminalTimeoutMs`, or as
  `session_exit` when the channel closes. `stdin_read` is never reported, and
  neither idleness nor timeout proves the foreground command exited.
- **Startup** collects output until silence (floor 250 ms) and publishes a
  bounded `motd`; the `terminalStartupTimeoutMs` deadline publishes a partial
  motd instead of failing, while a channel exit or abort during startup rejects
  the open.
- **`cwd`** on `remote_shell_open` is applied by sending `cd <quoted>` after the
  shell starts (a leading `~` becomes `"$HOME"`); a failed `cd` is not detected
  as a hard error — the shell stays alive and the error is visible in scrollback.
- **One active send per session** (`SEND_ACTIVE`); aborting a send's signal
  delivers INT and rejects the operation, while `cancel()` delivers INT and lets
  it settle normally.
- **Owner fencing is by exact Agent object identity** (`FOREIGN_SESSION` for any
  other agent, including a same-id lookalike object). `ctx.on("agent/disposed")`
  closes that agent's sessions; `ctx.effect` disposal awaits all closes.
- **Close/dispose are best-effort:** a failing PTY close is logged and the
  registry entry is still removed; disposal awaits every close with
  `Promise.allSettled`.
- **Scrollback** is an ANSI-stripped line ring: `\r` overwrites the current
  line, `\b` moves back, tabs use 8-column stops, a trailing partial line counts
  as a line, and `snapshot({offset,count,maxBytes})` keeps the newest tail when a
  byte cap cuts it.
- **The test fixture emulates a PTY over pipes** (no native PTY dependency): it
  accepts the requested window, forwards data/signals/exit status, and records
  `shellSessions` diagnostics, but it is not a byte-exact terminal and does not
  emulate terminal line discipline. Real remotes exercise a true PTY via ssh2.
- **The desktop "Persistent terminals" bundle is not required.** The shell
  surface is self-contained (own owner-scoped manager) because `ctx.terminals`
  is not mounted by default in Web/Desktop and is absent from the headless
  profile.

## Management UI (v0.3): "Remote Ops" page in the DSH Web GUI

The user-facing surface is a first-level sidebar panel ("Remote Ops" / 远程运维)
registered by the plugin's browser half, which renders host inventory, live shell
sessions, connection tests, and a recent-operations audit from a small Host HTTP
API.

### Host HTTP API — `lib/api.js`

Registered by `lib/index.js` through `ctx.inject(['webServer'], …)`:

```js
ctx.webServer.register({ kind: "prefix", path: "/dsh-remote/api", handler })
```

- Same-origin browser access only: the handler first runs the Host connection
  fence (`ctx.get("connection")?.requestRejection(req)`); any rejection answers
  `403` with `{ ok:false, error }`. When no connection service is mounted (CLI
  headless), the route is not registered.
- `POST` only, `content-type: application/json`, body `{ method, ...params }`,
  body cap 64 KiB, timeout ~20 s. Answers `{ ok:true, result }` or
  `{ ok:false, error:{ code, message } }` with status 400/403/404/405/500.
- Methods:
  - `overview` → `{ ok:true, result: { version, policy, allowHosts, readonlyHosts,
    sshConfigPath, hosts:[HostView], sessions:[SessionView], audit:[AuditEntry],
    counts:{hosts,sessions,audit} } }`
    - `HostView`: `{ name, target: "user@host:port", host, port, username, source,
      description?, tags?, readonly, allowed, authHint }`
    - `SessionView`: `{ sessionId, host, name?, status: {kind:"running"|"exited", exitCode?, signal?}, createdAt }`
  - `host.test` `{ name }` → `{ ok:true, result: { name, ok, latencyMs, output?,
    error? } }` (read-only: connect + one `uname -srm; hostname` exec, 12 s cap,
    8 KiB cap; a failed connection is a successful method with `ok:false`).
  - `session.read` `{ sessionId, offset?, count? }` → scrollback page
    `{ sessionId, host, text, totalLines, lineBegin, lineEnd, truncated }`.
  - `session.close` `{ sessionId }` → `{ sessionId, closed:true }`.
  - `audit.clear` `{}` → `{ cleared:true }`.
- `HostView.authHint` is one of `password env`, `key`, `ssh-agent`, `default keys`
  (never a secret value).

### Audit — `lib/audit.js`

Every model-facing remote tool call is recorded by wrapping each registered
`ToolDefinition.execute` in `lib/index.js` (no changes inside `lib/tools.js` /
`lib/terminal/tools.js`). Entry shape:

```js
{ id, time, tool, host, action, risk, outcome: "ok"|"error"|"denied", detail, durationMs }
```

- `tool` = model-facing tool name; `host` = `args.host` when present, else the
  shell session's host when resolvable, else `"—"`.
- `action` = short human label derived per tool (`exec`, `read`, `write`, `edit`,
  `list`, `transfer upload`, `probe`, `shell open/send/read/signal/close/list`);
  `risk` = static classifier level for exec/send (`low`/`gray`/`high`), `"write"`
  for mutating file ops, `"read"` for read-only tools.
- `detail` = bounded (300 chars) subject: command / path / sessionId / host.
- Ring buffer capped at 500 entries (process memory) and appended as JSONL to
  `$DSH_HOME/remote/audit.jsonl` (best effort, size-capped by truncation on
  start; failures logged, never thrown).

### Browser half — `lib/client.js`

Hand-written client bundle in the DSH module-loader format (no build step):

```js
window.__ModuleLoader__.load({ id: "dsh-remote", factory(require) { … return { name, inject:["slots"], apply(ctx) { … } } } })
```

- `ctx.effect(() => ctx.slots.register(
    { name:"sidebar.panellist", id:"dsh-remote", order:60, label: () => "远程运维" },
    RemoteOpsIcon))` — global panel row (`{size, active}` props).
- `ctx.slots.inject("main", () => ctx.slots.register({ name:"main", key:"dsh-remote" }, RemoteOpsPage))`
  — the keyed main-panel page matching the same id.
- Only `require("react")` is used (platform baseline module); styling is a
  plugin-scoped `<style data-plugin-css="dsh-remote/ops.css">` block plus DSH
  theme tokens (`--dsw-alias-*`). The page fetches `/dsh-remote/api` with
  `POST` + `credentials: "same-origin"` and refreshes on a timer plus a manual
  button.
- Page sections: header (title, version, counts, refresh, clear audit), policy
  strip, hosts table (with per-row "测试连接" result), live sessions table
  (scrollback preview + close), recent operations table (time/tool/host/action/
  risk/outcome/duration).
- `dsh.client` in `package.json`: `{ "platform": "web", "inject": [] }` — the
  bundle imports no other plugin modules; the `slots` service is awaited through
  Cordis injection.

### Management UI implementation notes (v0.3, as verified)

- **Client bundle without a build step.** `lib/client.js` uses the DSH module
  loader's factory form and `require("react")` only; it is declared through
  `package.json#dsh.client = { platform: "web", inject: [] }` and exported as
  `./client`. The host serves it from the profile's
  `node_modules/dsh-remote/lib/client.js`; a development loop
  (`scripts/dev-web-test.mjs`) boots an isolated Web profile in `.dsh-test`,
  drives Chrome with playwright-core, and writes a screenshot.
- **Slot registration must wait for the owner.** Registering into
  `sidebar.panellist` / `main` directly at apply time throws
  `slot "…" is not declared`; both registrations are therefore wrapped in
  `ctx.slots.inject(slotName, () => ctx.slots.register(…))` inside `ctx.effect`.
  The list id and the keyed `main` key are both `dsh-remote`; the label is the
  Chinese sidebar title 远程运维.
- **Page data path.** `fetch("/dsh-remote/api", { method:"POST",
  credentials:"same-origin", body:{method,…} })`; the host handler runs
  `ctx.get("connection").requestRejection(req)` first and answers 403 on any
  rejection, 503 when no fence service is mounted, 405 for non-POST, 404 for an
  unknown method or path, 400 for invalid JSON, 413 for an oversized body.
  The API registers only when `config.managementApi !== false` and
  `ctx.get("webServer")` exists (conditional `ctx.inject(["webServer"], …)`).
- **Audit wrapper.** `lib/index.js` wraps every registered ToolDefinition's
  `execute` (both the eight remote tools and the six shell tools) and records
  tool/host/action/risk/outcome/detail/duration, resolving the host from
  `args.host` or, for session-scoped tools, from `manager.describe`. Denials are
  detected from the tool error text and recorded as `denied` rather than
  `error`. Persistence is a synchronous JSONL append because a headless process
  may exit before async teardown; the retained tail (bounded ring) is reloaded
  on startup and the file compacted when it exceeds the limit.
- **Admin session surface.** The page's session list/close use the manager's
  owner-agnostic `adminList/adminGet/adminRead/adminClose` (documented in the
  terminal module as management-UI-only); agent tools keep exact-Agent fencing.
- **Browser verification.** The checked-in `docs/assets/management-page.png` was
  captured from a running DSH Web profile: the sidebar row and page render, the
  overview API returns the real `~/.ssh/config` hosts, a per-row "测试连接"
  reached a real SSH host (`连接正常 316ms · Linux … moon`), and the audit table
  showed the six operations produced by a real headless agent run (including a
  fail-closed `denied` high-risk `rm -rf`). No browser console errors and no
  failed HTTP responses were reported.
