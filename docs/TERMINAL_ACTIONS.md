# Cluster shortcut action contract

Implementation contract for replacing fixed `loginCommand` with `actions`.

## Profile

A shortcut declares `viaHost` and `actions` (1–32 items). An ordinary direct SSH host cannot declare actions. `viaHost` still resolves a direct entrance only, with existing allowHosts/readonly inheritance and terminal-only restrictions. Do not execute exec/probe/SFTP against the entrance as if it were the cluster.

Legacy `viaHost` + canonical `sww -r -u USER CLUSTER` migrates to one command action with `expectCluster: CLUSTER`, preserving root-on-target confirmation. Explicit new actions take precedence and normalized saved records no longer need `loginCommand`; metadata may retain it only for legacy compatibility. Reattaching an existing initialized PTY does not replay actions; every genuinely new channel initializes once, never resends a step after failure.

## Action shapes

All actions may have optional `label` (1–80 printable characters). Unknown fields and raw credential field names must be rejected.

- `{type:'command', value:string, expect?:string, expectCluster?:string, timeoutMs?:number}`: send a nonempty single-line command plus CR, then wait for a real shell prompt by default; `expect` selects a literal output completion condition. Legacy `expectCluster` selects the existing anchored target-cluster root prompt check; it is mutually exclusive with expect and must be a safe cluster name.
- `{type:'text', value:string, expect?:string, timeoutMs?:number}`: send printable raw text without Enter; optional literal completion condition. Without expect it completes after issuing input, so a following key/wait can complete interaction.
- `{type:'key', value:'Enter'|'Tab'|'Escape'|'Ctrl-C'|'Ctrl-D'|'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'|'Backspace', expect?:string, timeoutMs?:number}`: send the corresponding bytes once, optional literal completion condition.
- `{type:'wait', value:string, timeoutMs?:number}`: wait for literal sanitized output (not a regular expression).
- `{type:'delay', durationMs:number}`: cancellable bounded delay.

Command/text values are 1–4096 characters with no C0/DEL controls (no literal newline, CR, ESC, NUL). Literal expects/wait values are 1–2048 characters with no NUL/ESC; no user regex. Step timeout defaults to 30000ms, range 100–120000ms. Delay is 0–120000ms. Entire sequence capped at 20 minutes. Secrets must not be embedded in actions; SSH auth stays in the user-only password dialog or environment references.

## Execution

Existing exports `authorizeConnectionLogin` and `runConnectionLogin` stay callable. Normalize through the shared validator. Policy-check every command/text/key send with the existing approval/risk gate (including readonly and deny patterns); waiting/delay do not grant authority. No synthesized Agent, no implicit approval when saving a profile. Preserve current denial under always/never or unprovenCommands=ask for automatic send actions. Unsupported high-risk automation fails explicitly instead of silently bypassing policy.

The PTY opens only after entrance SSH authentication. Wait for the entrance shell prompt before a normal first send; when the first action is a literal wait, use that configured output as the readiness barrier for menu/custom-prompt entrances instead. A command's default shell-prompt completion does not prove exit code zero or the intended target; configure target-success output or expectCluster for login changes. Capture PTY output before any write and subscribe throughout the sequence so synchronous output is not lost between send/wait steps. Do not satisfy a later command using an earlier prompt/output. A standalone wait following text/key must be able to see the output those sends already emitted. Keep bounded sanitized output; avoid JS regex from user data. Stop immediately on timeout, cancellation or PTY exit and never run remaining actions. Leave native-model mounting/disposal to its owner.

`runConnectionLogin(pty, {profile,initialOutput,signal,timeoutMs,onCommand,onProgress})` reports safe progress:
`{state:'waiting-entry'|'running'|'completed'|'failed'|'cancelled', total:number, index:number, completed:number, type?:string, label?:string}`.
Index is zero-based during a step; final completion has index=total. Do not put raw output, text/key bytes or credentials in progress. Legacy onCommand remains for command sends only. Relay snapshots publish `actionProgress`, retain loginState compatibility (waiting/sent/confirmed/failed), and report connected only when all actions finish.

## UI

Host editor: replace fixed sww user/cluster fields with ordered action rows, type dropdown, relevant value/expected-output/timeout/delay fields, add/remove/move up/down. Preserve entrance selector, metadata, direct SSH form and existing password/native-terminal helpers. Include explainers for prompt-default command completion, literal waits, failure-stop behavior and no secrets in actions. Read old loginCommand into a migrated command row. Use `actions` in host create/update payloads. Show bounded step progress from relay `actionProgress`; do not auto-repeat, skip, or claim ready early.

## Verification

Test validation and deep-copy persistence/host loading; legacy migration and target root confirmation; sequential synchronous-output handling and fresh-output isolation; every action type; timeout/abort/exit fail-stop; policy denial before writes; no replay on reattach; editor payload/reordering/migration and privacy. Run the available complete regression suite, deploy via plugin_manager, verify live registration and be honest about manual real-host verification limits.
