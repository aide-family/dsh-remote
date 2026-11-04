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
- Terminal-only cluster shortcuts (viaHost/actions) inherit an entry SSH connection and run their saved terminal actions in order before becoming ready. Use only remote_shell_open/send/read/signal: exec, probe and SFTP would target the entry host and are disabled. Actions initialize each new PTY once; reattaching does not replay them. Failed, timed-out or cancelled sequences stop without sending remaining actions.
- Read-only tools (remote_hosts, remote_probe, remote_read, remote_list) run without approval. Under policy auto only commands the static classifier proves mutating need user approval; non-mutating and unproven commands run directly and fail closed only when approval is actually required but no answerer is mounted. remote_write, remote_edit, and remote_transfer always need approval. A denial is final for that action — do not try to route around it.
- Prefer remote_read and remote_list over running cat or ls through remote_exec: they are bounded, line-numbered, and path-aware.
- remote_exec is a non-interactive one-shot shell with no PTY and no persistent session. Every call starts in a fresh shell: pass workdir instead of cd, and start long-running processes detached (nohup … &).
- Check the [exit code: N] marker on every remote_exec result and investigate failures before moving on. A non-zero exit is a normal result, not a tool failure.
- Destructive actions (rm, service restart, kubectl delete, …) require approval: state the intent in description before running them.
- Never paste credentials, private keys, or tokens into a remote command or file; the connection authenticates itself.
- Remote output is bounded. When a result is truncated, refine the command or page on with remote_read offset instead of rerunning it blindly.`;

/** Order of the persistent-shell guidance (right after the remote-tools section). */
export const SHELL_PROMPT_ORDER = 1006;

export const REMOTE_SHELL_PROMPT_TEXT = `Persistent remote shells (dsh-remote): remote_shell_open, remote_shell_send, remote_shell_read, remote_shell_signal, remote_shell_close and remote_shell_list use one persistent PTY per DSH conversation and host across tool calls. When the native DSH terminal is enabled, it attaches to that exact PTY: human input and Ctrl-C affect the shell you use, and your later reads/sends continue in that state.
- Prefer remote_exec, remote_read, remote_write and remote_list for bounded one-shot work; open a shell only when you need persistent shell state, a REPL, or interactive input (password prompts, confirmations).
- Call remote_shell_open once per host in a conversation and reuse its session id; remote_shell_list recalls it. Close with remote_shell_close when the work is done. Sessions end when the Agent or harness is disposed. If a shared PTY exits, it is not silently replaced; a deliberate new open creates a fresh shell with no prior cwd, environment, or process state.
- Only one Agent send may be active per session. A send settles on output silence (inferred_idle), the send timeout, or shell exit; inferred_idle and timeout never prove the foreground command exited. A human may intervene directly in the shared native terminal; after a human takes over or sends Ctrl-C, read the session before deciding the next action.
- Every line submitted through Agent tools is risk-reviewed exactly like remote_exec: under auto only provably mutating lines ask, non-mutating and unproven lines run, and policy never or a read-only host denies mutating input. Direct human keystrokes are explicit operator actions and bypass Agent approval; their contents are never retained in the audit trail. Use submit: false for raw control input, or remote_shell_signal with SIGINT to interrupt a running command.
- Agent read results are ANSI-sanitized line text. The native DSH terminal is the interactive full PTY view; use it for full-screen TUI programs and human-assisted prompts.`;
