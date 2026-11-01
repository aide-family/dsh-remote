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

- `node --test test/unit/*.test.mjs test/integration/*.test.mjs` → **582 tests,
  582 pass** (parser, policy, config, hosts, known-hosts, ssh transport incl.
  interactive PTY and exec streaming, remote tools, shell tools/manager/
  scrollback, audit log, live hub, live SSE route, management HTTP API, tool-level
  live-event wiring, and real-fixture plugin integration tests).
- `node scripts/e2e.mjs` → **PASSED** against the real DSH headless profile:
  plugin load through the bundle patch, model-driven `remote_hosts`,
  `remote_exec` (read-only, `[exit code: 0]`), `remote_read` content, and a
  mutating `remote_exec` denied fail-closed without an answerer, an unproven
  (gray) command running without approval under the default policy, and a full
  persistent-shell cycle (`remote_shell_open` → `remote_shell_send` →
  `remote_shell_close`) echoing real PTY output.
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

## Live terminal mirror (v0.4): agent commands streamed into a right-sidebar terminal

Three product requirements drive this version:

1. **Non-mutating commands never ask.** Under `policy: auto`, only commands the
   static classifier proves mutating (`high`) need approval; `low` **and `gray`**
   (unproven, e.g. `curl`, `awk`, `python -c`, unknown binaries) run directly.
   A new config `unprovenCommands: "allow" | "ask"` (default `"allow"`) restores
   approval for gray commands. Read-only hosts, `policy: never` and
   `denyCommandPatterns` keep their stricter behaviour (`never` still denies
   gray, read-only hosts still deny anything not statically read-only).
2. **The conversation opens a live terminal on the right.** A right-sidebar tab
   ("远程终端") shows the remote commands the agent runs.
3. **Agent commands are injected into that terminal in real time**, so the user
   watches the actual execution (command line, streamed stdout/stderr, exit
   status), not just the final tool result.

### Host: streaming output

- `transport.exec(host, opts)` gains an optional `onData({ stream, chunk })`
  callback (`stream: "stdout"|"stderr"`, `chunk`: UTF-8 string decoded with a
  per-stream `StringDecoder` so multi-byte characters never split). Existing
  callers are unaffected; the returned result is unchanged.
- `manager.send({ agent, sessionId, text, submit, signal, onData? })` gains the
  same optional `onData({ stream: "stdout", chunk })` callback, fed with the
  sanitized text the PTY session appends to scrollback.

### Host: live hub + SSE

`lib/live.js` — `createLiveHub({ maxCommands, maxOutputPerCommand, maxTotalOutput })`:

```js
hub.begin({ sessionId, tool, host, command, kind }) -> LiveCommand
LiveCommand: { id, output(stream, text), note(text), end({ code?, error?, durationMs? }) }
hub.snapshot() -> { commands: [LiveCommandSnapshot...] }   // bounded, newest last
hub.subscribe(listener) -> unsubscribe                     // listener(event) for every event
hub.clear()
```

Events on the wire (one JSON object per SSE `data:` frame):

- `{ "type": "start", "id", "time", "sessionId", "tool", "host", "command", "kind" }`
- `{ "type": "output", "id", "stream": "stdout"|"stderr"|"note", "text" }`
- `{ "type": "end", "id", "time", "code"?, "error"?, "durationMs" }`
- `{ "type": "clear" }`
- The first frame after connecting: `{ "type": "snapshot", "commands": [...] }`
  (each snapshot command: id/sessionId/tool/host/command/kind/time/status/
  output (bounded) / code / error / durationMs / endedAt).

SSE route: `GET /dsh-remote/live` registered through the same `webServer` as the
management API, fenced by `ctx.get("connection").requestRejection(req)` (403 when
rejected, 503 when no fence service). Headers: `content-type: text/event-stream`,
`cache-control: no-cache`, `connection: keep-alive`. A `: ping` comment every
15 s; the stream closes when the request closes and unsubscribes from the hub.

Instrumentation (tool layer, `lib/index.js` passes a `live` dep):

- `remote_exec`: start before approval (denied attempts still appear, ended with
  `error`/`denied`), stream stdout/stderr via `transport.exec({ onData })`, end
  with the exit code.
- `remote_shell_send`: start with the input text, stream the send's output via
  `manager.send({ onData })`, end with `waitReason`/`sessionStatus` (nonzero
  code when the shell exited).
- `remote_shell_open` / `signal` / `close`: short informational start/end entries.
- Everything else stays off the live stream (reads/writes keep their cards).

Config: `liveTerminal: true` (register the SSE route + client tab trigger),
`autoOpenLiveTerminal: true` (the browser half opens the tab on the first live
command of the session).

### Client: right-sidebar tab

- Stage one: `ctx.sidebarRightTabs.register({ id: "dsh-remote-live",
  kind: "dsh-remote-live", title: () => "远程终端", guide: [{ id:
  "remote-terminal", order: 30, title, description }] })`.
- Stage two: `ctx.slots.register({ name: "sidebar.right.pane.tab", key:
  "dsh-remote-live" }, RemoteTerminalPanel)` (inside `ctx.slots.inject`).
- Opening: `ctx.sidebarRight.openTab("dsh-remote-live")` from the guide entry and
  automatically on the first live event of the current session when
  `autoOpenLiveTerminal` is on.
- The panel connects to `/dsh-remote/live` with `EventSource` (same-origin
  cookie), replays the snapshot, appends start/output/end frames as terminal
  lines (`$ command`, output, status line; ANSI stripped on the host), keeps
  auto-scroll unless the user scrolled up, offers Clear and a host filter, and
  reconnects automatically. It filters to the tab's session id when one is
  present (props `sessionId`), otherwise shows every session with a short label.

### Live terminal implementation notes (v0.4, as verified)

- **Policy semantics.** `authorize()` takes `mutating` (classifier `high`) and
  `unproven` (classifier `gray`) separately. Read-only hosts deny anything not
  proven read-only, `policy: never` denies both classes, `policy: always` asks
  for everything, and `policy: auto` asks only for `high` unless
  `unprovenCommands: "ask"` (then gray asks too). `denyCommandPatterns` still
  short-circuits before the live hub's `start`? No: the hub starts first so the
  attempt is visible, then the denial ends it with an error.
- **Streaming** is additive on both layers: `transport.exec({ onData })` uses a
  per-stream `StringDecoder` and never calls back after settlement;
  `manager.send({ onData })` forwards the sanitized text the PTY session appends
  to scrollback (PTY stderr is merged; stream is always `"stdout"`).
- **Hub bounds** are `maxCommands` 200, 64 KiB per command (tail kept), 1 MiB
  total; the oldest output is evicted first, then the oldest commands. A
  throwing subscriber is isolated. `clear()` emits a `clear` frame.
- **SSE** is an exact GET route fenced like `/api` (403 rejected, 503 without the
  connection service, 405 non-GET, 404 wrong path). The first frame is the
  snapshot; a `: ping` heartbeat runs every 15 s; disconnect unsubscribes.
- **Tool wiring** lives in the tool layer (`beginLive`/`sessionIdOf` helpers):
  `remote_exec` streams stdout/stderr and ends with the exit code, shell send
  streams sanitized output and a `[waitReason]` note, shell open/signal/close
  publish short informational entries; a missing or throwing hub can never break
  a tool call. Session identity comes from `exec.agent.session.id`.
- **Browser verification** (`scripts/dev-web-test.mjs`, liveui work): the tab
  type registers through `ctx.sidebarRightTabs` + `sidebar.right.pane.tab`,
  auto-opens on the first live `start` for the session, renders the SSE frames
  in a monospaced terminal-like log, and the checked-in screenshot
  `docs/assets/remote-terminal.png` was captured from a real DSH Web profile
  using the dev-only `live.emit` management method (`devLiveEvents: true` in the
  dev profile only).

### Client panel registration (v0.4, as verified by the browser loop)

- The browser half awaits the right-Sidebar services in a separate optional
  `ctx.inject(["sidebarRightTabs", "sidebarRight"], …)`, so a composition without
  that column still keeps the 远程运维 page; all registrations live in
  `ctx.effect`.
- Stage one: `sidebarRightTabs.register({ id: "dsh-remote-live", kind:
  "dsh-remote-live", title: () => "远程终端", guide: [{ id: "remote-terminal",
  order: 30, … }] })`; stage two: keyed `sidebar.right.pane.tab` and
  `sidebar.right.pane.tab.title` registrations under the same id.
- One shared `EventSource("/dsh-remote/live")` per page feeds every mounted
  panel and the auto-opener; the panel renders snapshot + start/output/end/clear
  with bounded client scrollback (200 commands / 120 KiB per command / 600 KiB
  total), host filter, connection state, local Clear (there is no host
  `live.clear` method; a local-cleared timestamp prevents a reconnect snapshot
  from resurrecting cleared commands), auto-follow with a jump-to-bottom chip,
  and automatic reconnect.
- Auto-open: the watcher takes the on-screen session from
  `sidebarRight.mounted`, and on the first `start` for it (null session counts,
  foreign sessions ignored) calls `openTab("dsh-remote-live")` once per session
  per page load when the overview flag `live.autoOpen` is true; `openTab` itself
  expands a collapsed column (verified).
- `scripts/dev-web-test.mjs --emit-live` drives the whole path in a real DSH Web
  profile: asserts the guide entry, collapses the column, emits three dev
  commands (two hosts), checks auto-open/已连接/command+output text/count,
  session and host filters, internal scrolling and bottom-follow semantics,
  scrolled-up freeze + jump back, and Clear; it fails non-zero on any
  console.error/pageerror/HTTP≥400. `docs/assets/remote-terminal.png` is the
  captured result; browser diagnostics were empty.

## Interactive user SSH terminal + host management (v0.5)

Six product requirements drive this version:

1. The right-sidebar terminal selects an available host and auto-creates the connection.
2. The user types commands in that terminal (not only watches the agent).
3. The host list supports quick connect: create the SSH connection, then open the
   conversation so the agent takes over operations.
4. The host list gains an actions column with a per-host audit button.
5. The Remote Ops page gains a host management entry (add/edit/delete connection
   info), modeled on Crescent's connection manager.
6. The terminal stays a real interactive terminal; one SSH session is reused per
   conversation and an SSH drop recovers automatically.

**Decision (user-confirmed):** the interactive terminal is DSH's own native
terminal (real xterm), not a second emulator inside the plugin panel. The
plugin's `dsh-remote-live` panel becomes the launcher/console: host picker,
session list, and the existing agent-command mirror.

### Files and ownership (v0.5)

| Path | Owner | Purpose |
| --- | --- | --- |
| `lib/host-registry.js` | hosts | persisted managed hosts CRUD (`$DSH_HOME/remote/hosts.json`) |
| `lib/hosts.js`, `lib/host-store.js` | hosts | merge registry hosts (`source: "managed"`), cache invalidation |
| `lib/audit.js` | hosts | host-filtered listing (`list({host,limit,offset})`, `count({host})`) |
| `lib/terminal/relay.js` | terminal | per-conversation SSH PTY session relay + local socket server + reconnect |
| `lib/terminal/bridge.cjs`, `bin/dsh-remote-terminal` | terminal | local bridge process run inside the native terminal |
| `test/unit/host-registry.test.mjs`, `test/unit/relay.test.mjs` | owners | unit coverage |
| `test/integration/relay.test.mjs` | terminal | real fixture SSH server + bridge child process |
| `lib/api.js`, `lib/index.js`, `lib/config.js`, `package.json` | lead | API methods, wiring, config, packaging |
| `lib/client.js` | client | panel + management page UI, native-terminal opener, quick connect |
| `scripts/dev-web-test.mjs`, `scripts/sync-profile.sh` | lead | browser verification, profile sync (bin/) |
| `README.md`, this document | lead | user docs + contracts |

Nobody edits another owner's files. Cross-owner behavior goes through the
contracts below.

### Managed host registry — `lib/host-registry.js`

```js
import { createHostRegistry } from "./host-registry.js";
const registry = createHostRegistry({ filePath, logger });
await registry.load();                       // best effort, empty on missing/corrupt file
registry.list()                              // ManagedHost[] (cached, sorted by name)
registry.get(name)                           // ManagedHost | undefined
await registry.create(input)                 // -> ManagedHost, validates + atomic write
await registry.update(name, input)           // -> ManagedHost
await registry.delete(name)                  // -> boolean
registry.filePath
```

`ManagedHost` (persisted record; never contains a secret value):

```js
{
  name: "prod-web-1",            // required, unique (case-insensitive), /^[A-Za-z0-9._-]{1,64}$/
  host: "10.0.0.11",             // required, no whitespace, <=255
  port: 22,                      // optional int 1..65535
  username: "ops",               // optional /^[A-Za-z0-9._-]{1,64}$/
  identityFile: "~/.ssh/prod",   // optional path (no secrets)
  passwordEnv: "PROD_PW",        // optional env-var NAME /^[A-Za-z_][A-Za-z0-9_]*$/
  passphraseEnv: "PROD_KEY_PW",  // optional env-var NAME
  proxyJump: ["bastion"],        // optional string or string[]; entries user@host[:port]
  tags: ["prod", "web"],         // optional <=16 entries, each <=32 chars
  description: "primary web",    // optional <=200 chars
  managed: true,                 // always true in the registry; added by the store
  createdAt: 1730000000000,
  updatedAt: 1730000000000
}
```

Rules:
- Persisted file format `{ "version": 1, "hosts": [ManagedHost…] }`, written
  atomically (temp file in the same dir + rename, mode 0600). Missing file is
  empty; a corrupt file warns and yields `[]` (never throws at load).
- Input validation rejects unknown `password`/`passphrase`/`secret`/`token`
  keys: only environment-variable NAMES are accepted, never values.
- `create` on an existing name (case-insensitive) → error `code: "HOST_EXISTS"`.
- `update`/`delete` on a missing name → `code: "HOST_NOT_FOUND"`.
- `load()` is idempotent; mutations update the in-memory list and the file.

Host merge (`lib/hosts.js`): `loadHosts(config, { homeDir, logger, registryHosts })`
merges in this priority by name: registry (`source: "managed"`, ids `managed:<name>`)
> plugin config (`source: "config"`) > `~/.ssh/config` (`source: "ssh-config"`).
`RemoteHost.source` becomes `"ssh-config" | "config" | "managed"`. Config hosts
still win over ssh-config. Registry hosts are validated the same way as config
hosts, so a malformed record never breaks discovery (skip + warn).
`host-store.js` accepts `{ registry }`: `list()` awaits `registry.load()` once,
passes the records to `loadHosts`, and exposes `invalidate()` (called by the API
after a mutation so the next tool call sees the new list).

### Audit host filter — `lib/audit.js`

- `list({ limit = 200, offset = 0, host } = {})` → entries (newest first),
  filtered by exact `entry.host === host` when `host` is given. Backwards
  compatible: no argument/limit-only keeps returning the array.
- `count({ host } = {})` → matching entry count.
- Relay lifecycle events are recorded as
  `{ tool: "terminal", host, action: "open" | "reconnect" | "close", risk: "read", outcome: "ok", detail }`.
  User keystrokes are never recorded (they may contain passwords typed at a
  `sudo`/password prompt).

### Relay + bridge — `lib/terminal/relay.js`, `lib/terminal/bridge.cjs`

The relay lives in the DSH Host process. It owns one SSH PTY per
`(conversation session id, host)` and serves the native terminal through a local
socket. The bridge process (spawned *inside* the DSH terminal by typing a
command into a fresh shell) connects to that socket and pipes raw bytes; xterm
renders the real remote terminal.

```js
import { createTerminalRelay } from "./terminal/relay.js";
const relay = createTerminalRelay({ transport, hosts, config, audit, logger, socketPath? });
await relay.start();                       // net server on the socket (idempotent)
const opened = await relay.open({ hostName, sessionId, cols?, rows? });
// { shell: { command, sessionKey, socketPath, host: {name, target} },
//   session: TerminalSessionView }
relay.list({ sessionId? })                 // TerminalSessionView[]
await relay.close(sessionKey)              // -> boolean
await relay.dispose()                      // close server + every session (quiescent)
relay.sessionKeyFor(sessionId, hostName)   // `${sessionId}::${hostName}`
relay.socketPath
```

`TerminalSessionView` (JSON-safe; never raw buffers):

```js
{
  sessionKey, host: "prod-web-1", target: "ops@10.0.0.11:22", sessionId: "<conversation>",
  state: "connecting" | "connected" | "reconnecting" | "closed" | "error",
  attached: 0,                 // connected bridge clients
  reconnectAttempt: 0,
  cols: 120, rows: 40,
  createdAt, updatedAt,
  lastError: null | string,
  bytesOut: 0,                 // total bytes forwarded from the PTY (bounded counter)
}
```

Behavior:
- `open` reuses a live session for the same key (this is the per-conversation SSH
  reuse); a closed/errored session is replaced. It resolves the host through
  `hosts.find`, rejects a disallowed (`allowHosts`) host with `code: "HOST_DISALLOWED"`,
  and opens `transport.openPty(host, { cols, rows, term: "xterm-256color" })`.
- Output: every PTY text chunk is appended to a bounded replay buffer
  (`userTerminalScrollbackBytes`, default 400 000) and broadcast to attached
  bridges. A new bridge gets `ESC[2J ESC[3J ESC[H` + the replay tail first.
- Auto-reconnect: an unexpected PTY exit/socket error sets `reconnecting`, writes
  a yellow banner into the stream, and retries with backoff 1s/2s/4s/8s/16s/30s
  up to `userTerminalReconnectAttempts` (default 5). A successful retry opens a
  new PTY, sets `connected`, writes `[dsh-remote] SSH 连接已恢复`, and keeps the
  bridge attached. Exhausted attempts → `error` + final banner.
- A bridge disconnect does not close the session. After the last bridge detaches,
  `userTerminalTtlMs` (default 1 800 000; 0 disables) starts; expiry closes the
  session (audit `close`). `close()` closes the PTY channel only.
- Socket: `$DSH_HOME/remote/terminal.sock` (dir 0700, socket 0600) on POSIX;
  `\\.\pipe\dsh-remote-terminal-<sha1 of DSH_HOME>` on Windows. A stale socket
  file is unlinked after verifying it is a socket; a second listener start on a
  live socket reuses it.
- Wire protocol (socket): the bridge opens the connection and sends exactly one
  JSON line handshake `{"v":1,"host":"<name>","sessionId":"<id>"}\n`; the server
  attaches (replay first) and then only raw UTF-8 PTY text flows server→bridge.
  Bridge→server frames are newline-delimited JSON:
  `{"t":"i","d":"<base64 utf8>"}` (input), `{"t":"r","c":<cols>,"r":<rows>}` (resize),
  `{"t":"c"}` (close request). Malformed frames are ignored; a disallowed host
  closes the socket. Handshake timeout 10s, session idle TTL as above.

`bin/dsh-remote-terminal` (POSIX shell, executable, packaged) resolves a node
binary (`$DSH_REMOTE_NODE`, then `node` on PATH, then a few common locations)
and `exec`s `lib/terminal/bridge.cjs`, forwarding all arguments. The bridge
(`bridge.cjs`, CommonJS, node builtins only):

```
--host <name> --session <id> --socket <path>
```

- Clears the screen, connects, sends the handshake, sets `stdin` raw (TTY only),
  pipes stdin→`{"t":"i"}` frames and server text→stdout, forwards SIGWINCH as a
  resize frame, and restores the terminal on exit.
- On socket close/error it prints `[dsh-remote] 终端桥接断开，正在重连…` and retries
  every 1s (bounded to 120 attempts) so a DSH Host restart also recovers; on
  stdin EOF / SIGINT / SIGTERM it exits cleanly.
- `relay.open().shell.command` is the exact shell line the client types into the
  native terminal:
  `exec <quoted bin path> --host <quoted> --session <quoted> --socket <quoted>`.

### Host HTTP API additions — `lib/api.js`

Same route `/dsh-remote/api`, POST `{method,…}`, same fence/limits. Adds:

| method | params | result |
| --- | --- | --- |
| `host.create` | `{ host: ManagedHostInput }` | `{ host: HostView }` |
| `host.update` | `{ name, host: ManagedHostInput }` | `{ host: HostView }` |
| `host.delete` | `{ name }` | `{ deleted: true }` |
| `audit.list` | `{ host?, limit?, offset? }` | `{ host, total, entries: AuditEntry[] }` |
| `terminal.open` | `{ name, sessionId? }` | `{ shell, session }` |
| `terminal.list` | `{ sessionId? }` | `{ sessions: TerminalSessionView[] }` |
| `terminal.close` | `{ sessionKey }` | `{ closed: true }` |

- `overview` gains `terminal: { enabled, available, socketPath, sessions }` and
  every `HostView` gains `managed: boolean` plus the secret-free connection
  fields the edit form prefills: `identityFile`, `passwordEnv`, `passphraseEnv`
  (environment-variable NAMES only) and `proxyJump: string[]`. Existing fields
  stay.
- Error codes (HTTP 400 unless noted): `HOST_INVALID`, `HOST_EXISTS` (409),
  `HOST_NOT_FOUND` (404), `HOST_NOT_MANAGED` (400), `HOST_DISALLOWED` (403),
  `TERMINAL_DISABLED`, `TERMINAL_NOT_FOUND` (404), `TERMINAL_ERROR` (500),
  `AUDIT_INVALID`. Registry mutation invalidates the host store.
- Config additions in `lib/config.js`: `userTerminal` (default true),
  `userTerminalTtlMs` (1 800 000), `userTerminalReconnectAttempts` (5),
  `userTerminalScrollbackBytes` (400 000), `hostRegistryPath` (default
  `$DSH_HOME/remote/hosts.json`). `lib/index.js` creates the registry + relay,
  loads the registry lazily, wires them into the API/audit/tools, and disposes
  the relay with the plugin.

### Browser half — `lib/client.js`

**Native terminal opener** (module-private helper; feature-detected so the page
still works without the terminal plugins):

```js
// runtimeCtx = the client plugin's root context captured in apply()
async function openNativeTerminal(sessionId, command) {
  const right = runtimeCtx.sidebarRight, terminals = runtimeCtx.webTerminals;
  if (!right || !terminals || typeof right.openTabIn !== "function") throw new Error("终端服务不可用");
  const tabs = right.openTabs;                       // snapshot store
  const before = new Set((tabs.getSnapshot() ?? []).map((tab) => tab.id));
  right.openTabIn(sessionId, "terminal", {});        // DSH's native terminal type
  const tabId = await waitFor(() => (tabs.getSnapshot() ?? [])
    .find((tab) => tab.kind === "terminal" && !before.has(tab.id)), 5000);
  const nav = right.tabDomain.occurrence(sessionId, { id: tabId }).navigation.getSnapshot();
  const view = terminals.view(sessionId, tabId, nav.address, undefined, undefined);
  await waitForState(view, (state) => state.writable === true, 20000);
  view.write(command + "\r");
}
```

**Quick connect / conversation handoff** (used by the page actions column and
the panel buttons):

```js
const opened = await callApi("terminal.open", { name, sessionId });   // creates/reuses the SSH PTY
await openNativeTerminal(sessionId, opened.result.shell.command);
const scope = runtimeCtx.sessions.scope(sessionId);
const conversation = scope?.conversation ?? scope?.get?.("conversation");
await conversation.send(`已连接远程主机 ${name}（${target}）。请在当前对话里继续这台主机的运维：先做一次只读健康检查（hostname、uptime、磁盘、内存、负载），再等我的指令。`);
```

- The management page resolves the on-screen session from
  `runtimeCtx.uiSession.current.getSnapshot()` (`sessionId` / `key` /
  `session.sessionId`); with no session it still opens the terminal and shows a
  notice instead of sending a message.
- The panel (session-scoped `props.sessionId`) always injects.
- Never send the message when `openNativeTerminal` failed; show the error inline.

**Remote Terminal panel (`RemoteTerminalPanel`)** — keeps the v0.4 mirror and adds:
- A host picker (`select`, `data-remote-terminal-host`) fed by the overview hosts.
- Buttons `打开终端` (`data-terminal-action="open"`) and `连接并对话`
  (`data-terminal-action="talk"`).
- A session list from `overview.terminal.sessions` with host, state label,
  attached count, `打开` (`data-terminal-action="attach"`) and `关闭`
  (`data-terminal-action="close"`). `打开` re-calls `terminal.open` (same key) and
  reattaches a native terminal to the live session.
- Existing data attributes (`data-dsh-remote-live`, `data-live-connection`,
  `data-live-command-id`, `.dslt-log`, `.dslt-btn`, filters) stay for v0.4 tests.

**Remote Ops management page (`RemoteOpsPage`)**:
- Header gains `添加主机` (`data-host-action="create"`).
- Hosts table gains an 操作 column with per-row buttons
  `连接` (`data-host-action="connect"`), `审计` (`data-host-action="audit"`),
  `编辑` (`data-host-action="edit"`, managed hosts only), `删除`
  (`data-host-action="delete"`, managed hosts only), each carrying
  `data-host-name`. The existing per-row `测试连接` stays.
- Host form modal (`data-dsh-remote-host-form`): fields `name`, `host`, `port`,
  `username`, `identityFile`, `passwordEnv`, `passphraseEnv`, `proxyJump`
  (comma separated), `tags` (comma separated), `description`; inline validation
  error; hints that auth values are environment-variable NAMES, not secrets,
  and that `~/.ssh/config` hosts are read-only here.
- Audit modal (`data-dsh-remote-audit`, rows `data-audit-entry`): fetch
  `audit.list { host }`, show time/tool/action/risk/outcome/duration/detail,
  refresh + close; empty state when the host has no recorded operations.
- The page refreshes the overview every 10s; a mutation triggers an immediate
  refresh.

### Verification contract (v0.5)

- `npm test` keeps passing and adds unit coverage for the registry, audit host
  filter, relay (reuse, replay, reconnect, TTL) and integration coverage for the
  real fixture SSH server through the relay + bridge child process.
- `scripts/dev-web-test.mjs` gains `--remote-terminal`: boots the isolated Web
  profile with a fixture SSH host in the plugin config, starts the fixture SSH
  server, clicks `连接` for that host, waits for the native terminal tab, types
  `printf 'terminal-ok\n'`, asserts the output plus the injected user message,
  exercises the audit modal (the agent-run commands appear under the host), the
  host form (create/edit/delete round-trip) and captures updated screenshots.
- `docs/assets/management-page.png` and `docs/assets/remote-terminal.png` are
  regenerated by that run.
- A packaged tarball install must include `bin/` and `lib/terminal/bridge.cjs`.

### v0.5 implementation notes (as verified)

These are the deliberate deltas from the v0.5 contract above; all are additive
or compatible, and the full suite plus the real browser run agree with them.

- **Managed-host registry.** `lib/host-registry.js` returns defensive copies,
  writes `{version:1,hosts:[…]}` atomically (temp+rename, file 0600, dir 0700),
  serializes mutations with in-memory rollback, accepts integer strings for
  `port` and comma-separated strings for `proxyJump`/`tags`, treats empty
  optional strings as unset, ignores unknown non-secret keys, and rejects raw
  `password`/`passphrase`/`secret`/`token` keys with `HOST_INVALID`. `delete()`
  on a missing name throws `HOST_NOT_FOUND` (the API maps a missing *managed*
  name that exists in the merged list to `HOST_NOT_MANAGED`), and `update()`
  supports rename while keeping the current name when omitted.
- **Host merge.** Managed hosts carry `source: "managed"`, `id: "managed:<name>"`
  and `managed: true`. `createHostStore({registry})` awaits `registry.load()`
  before discovery and exposes `invalidate()` with a generation guard so an
  in-flight discovery cannot repopulate a stale cache.
- **Relay split.** The socket server lives in a separate internal helper
  `lib/terminal/relay-socket.js` (handshake, framing, stale-vs-live socket
  handling, `unref()`ed listener) to keep `lib/terminal/relay.js` under the
  ~700-line convention; `relay.js` re-exports the public helpers, so
  `import { createTerminalRelay } from "./terminal/relay.js"` is unchanged.
  A live socket is probed and reused, never unlinked; a second instance on the
  same path gets `start()` success but `open()` fails `TERMINAL_ERROR`. Failed
  `open()` promises settle to the entry (never reject unhandled) — otherwise a
  single unreachable host would crash the Host process on Node 22.
- **API facade.** `lib/index.js` passes the API a thin relay facade
  (`{enabled, available, socketPath, start, open, list, close}`) so `overview`
  can report/retry availability. `terminal.open` maps relay `HOST_DISALLOWED` to
  HTTP 403 and the host store's `UNKNOWN_HOST` to `HOST_NOT_FOUND` 404; a failed
  PTY open is a structured `TERMINAL_ERROR` 500 and never takes the process down.
- **Native terminal opener (browser).** Two shape facts differ from the sketch:
  `ctx.sidebarRight.openTabs` publishes `{sessionId, tabId, kind, contentId}`
  (not `tab.id`; the client normalizes `tabId || id`), and the main column must
  first show the conversation — `ctx.uiWorkspace.openSession(sessionId)` +
  `sidebarRight.mounted` poll — or the terminal tab's seat never mounts while a
  root panel page (the Remote Ops page) owns the main view. The client also waits
  for `webTerminals.view(...).state.writable` before writing the bridge command.
- **Conversation handoff.** The page action `连接` and the panel action
  `连接并对话` open the terminal first and only then send the scoped
  `conversation.send(...)`; a failed terminal never injects. The panel's
  `打开终端` is terminal-only, and `打开` on a session row re-calls
  `terminal.open` (same key → same SSH PTY) without injecting.
- **OpenTabs/terminal typing.** The bridge receives the command as one shell
  line (`exec "<abs>/bin/dsh-remote-terminal" --host … --session … --socket …`),
  so no `api-terminal-controller` shell/profile config patch is needed; the
  launcher resolves node (`$DSH_REMOTE_NODE` → PATH → common locations) and the
  socket is user-only (`$DSH_HOME/remote/terminal.sock`, dir 0700, socket 0600).
- **Verification environment.** The browser loop must run where the DSH Host may
  allocate a POSIX PTY (running it inside an agent file sandbox fails with
  `posix_openpt failed: Operation not permitted`); `scripts/dev-web-test.mjs
  --remote-terminal` boots the isolated Web profile with a real SSH fixture host
  and covers actions column, quick connect, native terminal typing + output,
  conversation handoff, per-host audit modal, host-manager add/delete and
  per-conversation session reuse. `--docs-shots` writes both README screenshots.
- **Verified (v0.5).** `npm test` → **642 tests, 642 pass** (unit + real-fixture
  integration, ~11 s). `node scripts/dev-web-test.mjs --remote-terminal
  --docs-shots` against the isolated Web profile with a real fixture SSH host →
  **PASS** with zero failures and zero browser console/HTTP diagnostics: actions
  column, quick connect (relay PTY + native terminal mount), typed
  `printf 'terminal-ok\n'` → `terminal-ok`, `已连接远程主机 termbox（…）` handoff,
  per-host audit modal with the `terminal termbox open` event, host-manager
  add/delete round-trip, and second `terminal.open` returning the same
  `sessionKey`; both `docs/assets/*.png` regenerated by that run.

## v0.5.1 — connection reliability, full audit view/export, recent-20

User feedback after running v0.5 in the Desktop app:

1. Clicking 打开/连接 only opened a local terminal; the SSH connection was not
   completed inside it.
2. Commands still looked confined to the fixed panel window with no manual
   intervention, and whether the SSH session is reused was invisible.
3. Audit commands must be fully viewable and exportable.
4. Recent operations only needs the latest 20.

### Backend contract additions

- **`TerminalSessionView` counters** (additive):
  `bytesIn` (bridge input bytes accepted), `attachCount` (cumulative bridge
  attaches), `lastAttachAt`, `lastDetachAt` (ms epoch or null). A second attach
  to the same `sessionKey` without a new `terminal.open` proves relay reuse.
- **Audit lifecycle**: the relay records `terminal` entries for `attach` and
  `detach` in addition to `open`/`reconnect`/`close`, with
  `detail: "<sessionKey> (attached N)"`. A `terminal open` without a following
  `attach` means the local bridge never reached the relay.
- **Node launcher resolution** (`lib/terminal/node-launcher.js`, pure):
  the shell line the client types must not depend on the terminal's `PATH`.
  `resolveNodeLauncher({ env, execPath, versions, platform, existsSync })` returns
  a shell command prefix, tried in this order:
  1. `env.DSH_REMOTE_NODE` when it is an existing executable;
  2. `execPath` directly when the Host does not run under Electron
     (`versions.electron` absent);
  3. `ELECTRON_RUN_AS_NODE=1 <execPath>` when the Host runs under Electron and a
     one-shot `--version` probe with that env succeeds (cached);
  4. a bundled runtime node next to `execPath`
     (`<app>/Contents/Resources/runtime/bin/node`,
     `.../runtime/primary-runtime/dependencies/node/bin/node`, and the
     Windows/Linux equivalents `resources/runtime/...`);
  5. `'<abs>/bin/dsh-remote-terminal'` (the launcher that resolves node from
     PATH/常见位置). The final command is
     `exec <nodePrefix> '<lib/terminal/bridge.cjs>' --host … --session … --socket …`
     with every argument shell-quoted.
- **Bridge log**: `bridge.cjs` appends bounded diagnostics to
  `terminal-bridge.log` next to the socket path: start (host/session/socket),
  connected, connect error (`code`/message), close, reconnect, exhausted, exit.
  It is best-effort, never throws, and trims to the last 64 KiB once it exceeds
  256 KiB. This distinguishes "bridge never ran" (no file) from "bridge ran but
  could not attach" (error lines) without asking the user to read scrollback.
- **Client trace**: `terminal.trace {stage, sessionId?, detail?}` (POST) appends
  one line to `$DSH_HOME/remote/terminal-debug.log` (bounded to 256 KiB). Stages
  the panel sends: `api`, `tab`, `writable`, `write`, `attached`, `timeout`,
  `error`. It is fire-and-forget from the client and never affects the action.
- **Audit detail**: every entry keeps the existing 300-char one-line `detail`
  (table) and gains `detailFull` — the raw subject (command/script/path)
  preserved up to 16 384 chars with whitespace intact, for the full viewer and
  exports. `audit.list({ host, limit, offset, full })` includes `detailFull`
  only when `full: true`; `overview.audit` stays lightweight.
- **Recent operations**: `overview.audit` is exactly the newest 20 entries
  (`limit: 20`). The audit modal/export uses `audit.list` with its own limit.
- **API**: `terminal.trace` added; `audit.list` gains `full`.

### Client contract additions (`lib/client.js`)

- After `view.write(command + "\r")`, poll `terminal.list` for the opened
  `sessionKey` until `attached >= 1` (10 s). While not attached, re-write the
  command at ~2 s and ~4 s (a shell that swallowed the first line recovers); on
  timeout raise an actionable notice ("终端已打开但桥接未接入…") that shows the
  command and offers 复制命令, with the hint to check
  `$DSH_HOME/remote/terminal-bridge.log`. Trace every stage; the notice is the
  user-visible half of the same evidence.
- Panel session rows show `接入 N` (attached), the short sessionKey, and a
  `复用` badge when `attachCount > 1` or the session was reopened; the header
  explains that the native terminal tab is the interactive surface.
- Recent operations section header: `最近 20 条操作` and a 导出 button
  (JSON/CSV/TXT of `audit.list` with `limit: 500, full: true`).
- Audit modal: each row expands to the full `detailFull` (whitespace preserved),
  and 导出 JSON/CSV/TXT exports the current host's entries with full detail.
- Version 0.5.1; README/ARCHITECTURE updated; browser E2E asserts the attach
  audit event, full command expansion, export download, and `overview.audit`
  length ≤ 20.

#### v0.5.1 verification (as verified)

- `npm test` → **669 tests, 669 pass** (unit + real-fixture integration; baseline
  642, +27: node-launcher branches/quoting, relay attach/detach audit +
  counters + dispose deadlock regression, audit `detailFull`/legacy backfill,
  management API overview-20 / `audit.list full` / `terminal.trace` / counters).
- `node scripts/dev-web-test.mjs --remote-terminal --docs-shots` against the
  isolated Web profile with a real SSH fixture → **PASS**, zero failures and zero
  browser diagnostics. The run proves: `terminal.list` reports
  `attachCount=1, bytesIn=23` for the typed command; the per-host audit shows
  `terminal … attach`; an audit row expands to the full raw detail; the modal's
  JSON export downloads a non-empty entry array containing `detailFull`; the
  page title is `最近 20 条操作` and `overview.audit.length <= 20`; the second
  `terminal.open` returns the same `sessionKey` (reuse). Both docs screenshots
  were regenerated by this run.
- Real Desktop note: the resolved `shell.command` on an Electron Host is
  `exec env ELECTRON_RUN_AS_NODE=1 '<app binary>' '<…/lib/terminal/bridge.cjs>'
  --host …`, verified locally with the packaged app binary
  (`ELECTRON_RUN_AS_NODE=1 … --version` → v24.21.0), so the bridge no longer
  depends on the terminal's `PATH`.

## v0.5.2 — 连接 opens a new conversation; visible failures; manual fallback

Real-Desktop retest of v0.5.1: `terminal.open` succeeded but the native terminal
tab never appeared (`打开原生终端超时：5 秒内没有出现新的终端标签页`); the user
saw only a plain local zsh and no diagnostic, on a session whose persisted right
sidebar layout was an empty pane. The terminal tab is created through
`sidebarRight.openTabIn`, which silently no-ops unless that session's right
sidebar layout store is adopted — so the flow must run against a freshly
navigated conversation, and every failure after navigation must stay visible.

### Flow contract (`lib/client.js`)

- **连接 / 连接并对话** (management page host row and the panel's talk button)
  now: (1) create/open a blank conversation with optional
  `uiWorkspace.startSession()`; (2) wait (≤8 s) for `uiSession.current` to yield
  a session id and `sidebarRight.mounted` to equal it — a reused blank may keep
  the previous id, and that is accepted; (3) `terminal.open {name, sessionId:
  <new id>}` so the relay key `${sessionId}::${host}` matches the conversation
  the terminal will live in (reopening from that conversation therefore reuses
  the same SSH PTY); (4) open the native terminal in that session and write the
  bridge command; (5) after attach verification, send the handoff message into
  that session. A missing `uiWorkspace`/timeout traces `session` + `fallback`
  and uses the current-session flow instead.
- Panel 打开终端 / 接入 keep the current-session behavior (no new conversation).
- **Failures after navigation are never silent.** A module-level pending notice
  (message + command + bridge-log hint) is set and `sidebarRight.openTab(
  "dsh-remote-live")` reveals the 远程终端 panel, which renders the notice with
  the command `<pre>` and 复制命令. This is what the empty-local-terminal
  complaint needed.
- **Manual fallback**: the panel gains a permanent 复制连接命令 button
  (`data-terminal-action="copy-command"`) that calls `terminal.open` for the
  selected host and copies `shell.command`, so any terminal can be used to
  establish the relay connection by hand.
- **Trace**: new stages `session` (uiWorkspace availability, startSession,
  previous/new id, waited ms, fallback) and `reveal` (mounted before/after),
  plus a `tab-probe` detail on tab-wait failure (openTabs count before, mounted
  id, `tabsIn(sessionId).length`, active kind/id, `openTabIn` availability);
  `openTabIn` is retried once after ~800 ms before giving up.
- Browser E2E asserts the on-screen conversation changes after 连接 (new
  conversation) in addition to the v0.5.1 assertions. Version 0.5.2.

#### v0.5.2 verification (as verified)

- `npm test` → **669 tests, 669 pass** (the management-API overview test now
  reads the version from package.json instead of a hardcoded value).
- `node scripts/dev-web-test.mjs --remote-terminal` in the isolated **webtest**
  profile → PASS: new-conversation switch (main column leaves the Remote Ops
  page and shows a conversation), native terminal mount, bridge attach
  (`attachCount=1`, `bytesIn=23`), typed command output, handoff message in the
  conversation, per-host audit `attach` event + full-detail expansion + JSON
  export download with `detailFull`, overview audit ≤ 20, and session reuse.
- The same browser run in an isolated **Desk-like** composition
  (`dsh-better-sidebar` installed, `DEV_WEB_PROFILE=deskbug`) → PASS, which
  rules out that common Desktop plugin as the cause of the v0.5.1 empty terminal.
- The client's scratch harness (104 checks) proves the corrected order
  (`startSession` before `terminal.open` with the new id), the fallbacks, the
  pending-panel-notice path (visible command + copy after navigation), and the
  permanent 复制连接命令 button.
