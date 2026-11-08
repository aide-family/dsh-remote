const error = (message, code) => Object.assign(new Error(message), { code });
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

/** Independent identity/context inspection; no template or workflow dependency. */
export function createTargetCheckTool({ defineTool, hosts, targets }) {
  return defineTool({ name: 'remote_target_check',
    description: 'Run configured identity/cluster/context checks in the actual SSH command context or owned PTY. Exact values and exit codes are checked; prompts are not identity proof. reset_input=true explicitly interrupts foreground input/program and clears the PTY line, requiring independent approval. Unknown readiness otherwise fails closed.',
    parameters: {
      host: { type: 'string', required: true, description: 'Logical host from remote_hosts.' },
      session_id: { type: 'string', description: 'Actual owned PTY for a cluster shortcut; never check its entrance using exec.' },
      reset_input: { type: 'boolean', description: 'Explicitly approve Ctrl-C/Ctrl-U readiness reset; may interrupt an existing foreground operation.' },
      workdir: { type: 'string', description: 'Absolute direct-exec working directory; PTY checks use actual current cwd.' },
    }, output: { schema: { type: 'json' }, render },
    async execute(args, exec) {
      const host = await hosts.find(String(args.host ?? ''));
      if (!host || !hosts.isAllowed(host)) throw error('Target host is not allowed.', 'HOST_NOT_ALLOWED');
      if (args.workdir !== undefined && (typeof args.workdir !== 'string' || !args.workdir.startsWith('/') || /[\0\r\n]/.test(args.workdir))) throw error('Target workdir must be an absolute path without controls.', 'TARGET_WORKDIR_INVALID');
      return targets.check({ host, exec, sessionId: args.session_id, resetInput: args.reset_input === true, workdir: args.workdir, toolName: 'remote_target_check' });
    }, presentCall: args => ({ card: 'generic', kind: 'execute', title: `Check configured target on ${args.host}${args.reset_input ? ' (explicit input reset)' : ''}` }),
  });
}
