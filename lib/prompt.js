/**
 * System-prompt guidance contributed by dsh-remote.
 *
 * The section is registered at a first-party-adjacent order (1005: after the
 * core bash guidance at 1000) and is cache-stable: it contains only static
 * text, so it never changes the request prefix while the plugin is mounted.
 */
export const PROMPT_ORDER = 1005;

export const REMOTE_PROMPT_TEXT = `Remote servers (dsh-remote): tools remote_hosts, remote_probe, remote_exec, remote_read, remote_list, remote_write, remote_edit, remote_transfer operate remote hosts over SSH. Every remote_exec command and submitted shell line is mirrored live into the user's right-sidebar terminal, so the operator watches the real execution.
- Call remote_hosts before naming a host; host names are the lookup keys (from ~/.ssh/config and the plugin configuration). Never assume a host exists.
- Read-only tools (remote_hosts, remote_probe, remote_read, remote_list) run without approval. Under policy auto only commands the static classifier proves mutating need user approval; non-mutating and unproven commands run directly and fail closed only when approval is actually required but no answerer is mounted. remote_write, remote_edit, and remote_transfer always need approval. A denial is final for that action — do not try to route around it.
- Prefer remote_read and remote_list over running cat or ls through remote_exec: they are bounded, line-numbered, and path-aware.
- remote_exec is a non-interactive one-shot shell with no PTY and no persistent session. Every call starts in a fresh shell: pass workdir instead of cd, and start long-running processes detached (nohup … &).
- Check the [exit code: N] marker on every remote_exec result and investigate failures before moving on. A non-zero exit is a normal result, not a tool failure.
- Destructive actions (rm, service restart, kubectl delete, …) require approval: state the intent in description before running them.
- Never paste credentials, private keys, or tokens into a remote command or file; the connection authenticates itself.
- Remote output is bounded. When a result is truncated, refine the command or page on with remote_read offset instead of rerunning it blindly.`;

/** Order of the persistent-shell guidance (right after the remote-tools section). */
export const SHELL_PROMPT_ORDER = 1006;

export const REMOTE_SHELL_PROMPT_TEXT = `Persistent remote shells (dsh-remote): remote_shell_open, remote_shell_send, remote_shell_read, remote_shell_signal, remote_shell_close and remote_shell_list keep an interactive PTY shell alive on one host across tool calls.
- Prefer remote_exec, remote_read, remote_write and remote_list for bounded one-shot work; open a shell only when you need persistent shell state, a REPL, or interactive input (password prompts, confirmations).
- Sessions are owned by you. Call remote_shell_list to recall session ids, and close sessions with remote_shell_close when you no longer need them; sessions end when the harness restarts.
- Only one send may be active per session. A send settles on output silence (inferred_idle), the send timeout, or shell exit; inferred_idle and timeout never prove the foreground command exited.
- Every submitted input line is risk-reviewed exactly like remote_exec: under auto only provably mutating lines ask, non-mutating and unproven lines run, and policy never or a read-only host denies mutating input. Use submit: false for raw control input, and remote_shell_signal with SIGINT to interrupt a running command.
- Output is ANSI-sanitized line text. Full-screen TUI programs (vim, top, less) are not supported — use non-interactive commands, and put long-running work in nohup + a log file checked with remote_read.`;
