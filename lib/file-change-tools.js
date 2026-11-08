import { posix } from "node:path";
import { createFileChanges } from "./file-change.js";
import { assessCommand, countOccurrences, describeError, normalizeTimeout, shortText } from "./render.js";

/** Safe-file Agent tool definitions; approval, host resolution and live plumbing are injected. */
export function createFileChangeTools(deps) {
  const { defineTool, transport, maxReadBytes, maxOutputBytes, execTimeoutMs, render,
    authorizeAction, prepareHost, expandRemotePath, approval, live, beginLive, sessionIdOf, assertSftpMutation, dispatchSnapshot, revalidateDispatch } = deps;
  // Guard context is trusted callback state only: never return it or include it in backups/audit facts.
  function captureGuard(host) {
    if (dispatchSnapshot === undefined && revalidateDispatch === undefined) return undefined;
    if (typeof dispatchSnapshot !== "function" || typeof revalidateDispatch !== "function") throw Object.assign(new Error("File dispatch guard callbacks are unavailable."), { code: "TARGET_GUARD_UNAVAILABLE" });
    const snapshot = dispatchSnapshot(host);
    if (!snapshot || typeof snapshot.expectedChecksHash !== "string" || !snapshot.expectedChecksHash || typeof snapshot.expectedConnectionDigest !== "string" || !snapshot.expectedConnectionDigest) throw Object.assign(new Error("Invalid file dispatch gate snapshot."), { code: "TARGET_GUARD_UNAVAILABLE" });
    return { snapshot: Object.freeze({ ...snapshot }), writeApprovedOnce: false, verificationApprovedOnce: false };
  }
  // --- Safe file changes and restore -----------------------------------------

  const fileChanges = createFileChanges({
    transport, backupRoot: deps.backupRoot, maxReadBytes,
    async authorize({ toolName, exec, host, path, preview, guardContext }) {
      const decision = await authorizeAction({ toolName, exec, host, action: "write", subject: path, mutating: true, preview });
      if (guardContext) guardContext.writeApprovedOnce = decision?.outcome === "allowed-once";
      return decision;
    },
    async beforeWrite({ host, guardContext }) {
      if (guardContext) await revalidateDispatch(host, guardContext.snapshot, { sftp: true, mutating: true, approvedOnce: guardContext.writeApprovedOnce });
    },
    async verify({ host, exec, command, timeoutMs, authorizeOnly, toolName, guardContext }) {
      if (authorizeOnly) {
        const assessment = assessCommand(approval, command);
        if (assessment.denied) throw Object.assign(new Error(assessment.denied), { code: "DENIED" });
        const decision = await authorizeAction({ toolName, exec, host, action: "execute", subject: command,
          mutating: assessment.level === "high", unproven: assessment.level === "gray",
          verb: assessment.verb, description: "Independent post-change verification command" });
        if (guardContext) guardContext.verificationApprovedOnce = decision?.outcome === "allowed-once";
        return;
      }
      if (guardContext) {
        const assessment = assessCommand(approval, command);
        if (assessment.denied) throw Object.assign(new Error(assessment.denied), { code: "DENIED" });
        await revalidateDispatch(host, guardContext.snapshot, { command, mutating: assessment.level !== "low", approvedOnce: guardContext.verificationApprovedOnce });
        exec.signal?.throwIfAborted();
      }
      const liveCommand = beginLive(live, { sessionId: sessionIdOf(exec), tool: toolName, host: host.name, command, kind: "exec" });
      try {
        const result = await transport.exec(host, { command, timeoutMs, maxBytes: maxOutputBytes, signal: exec.signal,
          ...(liveCommand ? { onData: (event) => liveCommand.output(event?.stream, event?.chunk) } : {}) });
        liveCommand?.end({ code: result.code, durationMs: result.durationMs });
        return { status: result.timedOut ? "timed_out" : result.signal || result.code == null || result.code < 0 ? "unknown" : result.code === 0 ? "passed" : "failed",
          exitCode: result.code ?? null, timedOut: result.timedOut === true };
      } catch (error) { liveCommand?.end({ error: describeError(error) }); throw error; }
    },
  });
  const verificationParameters = {
    verify_command: { type: "string", description: "Optional independently risk-reviewed command to execute exactly once after writing; failure never auto-restores or reloads." },
    verify_timeout_ms: { type: "integer", description: "Verification timeout in milliseconds, defaults to configured exec timeout." },
  };
  function verificationOptions(args) {
    const command = args.verify_command;
    if (command !== undefined && (typeof command !== "string" || !command.trim())) throw new Error("verify_command must be a non-empty command.");
    return { verifyCommand: command?.trim(), verifyTimeout: normalizeTimeout(args.verify_timeout_ms, execTimeoutMs) };
  }
  async function safePath(host, raw, exec) {
    const path = await expandRemotePath(host, raw, exec);
    // SFTP relative paths resolve against the user's home, not a shell's cwd.
    if (posix.isAbsolute(path)) return posix.normalize(path);
    const home = await transport.homeDir(host, { signal: exec.signal });
    if (!posix.isAbsolute(home)) throw new Error("Cannot resolve absolute remote target path.");
    return posix.resolve(home, path);
  }
  const remoteWrite = defineTool({
    name: "remote_write",
    description: "Safely create or replace a remote UTF-8 file. Approval includes bounded before/after Diff. Existing files require a private durable backup; versions are rechecked after approval and plugin writers serialized per target. Regular files only, no symlinks. Preserves mode/uid/gid via atomic SFTP replacement where supported. SFTP does not provide external-writer atomic CAS. Optional verification is independently authorized before writing and runs once afterward; failures carry recovery facts and never automatically reload or restore.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote file path; ~ expands to remote home." },
      content: { type: "string", required: true, description: "Complete new UTF-8 content, bounded by safe-change size limit." },
      create_dirs: { type: "boolean", description: "Create missing parents if true." },
      ...verificationParameters,
    },
    output: { schema: { type: "json" }, render: render.remote_write },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const guardContext = captureGuard(host);
      assertSftpMutation?.(host);
      const path = await safePath(host, args.path, exec);
      return fileChanges.change({ host, path, exec, guardContext, toolName: "remote_write", createDirs: args.create_dirs,
        ...verificationOptions(args), transform: () => ({ content: Buffer.from(String(args.content ?? ""), "utf8") }) });
    },
    presentCall: (args) => ({ card: "generic", kind: "edit", title: `Write ${shortText(args?.host, "remote host")}:${shortText(args?.path, "file")}` }),
  });
  const remoteEdit = defineTool({
    name: "remote_edit",
    description: "Safely replace exact text in an existing remote regular file. No symlinks. Missing or ambiguous matches fail before approval. Approval includes bounded Diff; a private durable backup is mandatory, then version revalidation detects changes during approval. Plugin writers are serialized but external-writer atomic CAS is unavailable through SFTP. Preserves mode/uid/gid. Optional independently reviewed verification runs once after writing; errors carry backup/version facts, without automatic reload or restore.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote file path." },
      old_string: { type: "string", required: true, description: "Exact text to replace." },
      new_string: { type: "string", required: true, description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence when true." },
      ...verificationParameters,
    },
    output: { schema: { type: "json" }, render: render.remote_edit },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const guardContext = captureGuard(host);
      assertSftpMutation?.(host);
      const path = await safePath(host, args.path, exec);
      const old = typeof args.old_string === "string" ? args.old_string : "";
      const next = typeof args.new_string === "string" ? args.new_string : "";
      if (!old) throw new Error("old_string is required and must not be empty.");
      if (old === next) throw new Error("old_string and new_string are identical; nothing to change.");
      return fileChanges.change({ host, path, exec, guardContext, toolName: "remote_edit", ...verificationOptions(args),
        transform(before) {
          if (!before) throw new Error(`Remote file not found: ${host.name}:${path}. remote_edit only edits existing files.`);
          const current = before.content.toString("utf8");
          if (!Buffer.from(current, "utf8").equals(before.content)) throw new Error("remote_edit requires valid UTF-8 text; refusing a lossy binary edit.");
          const matches = countOccurrences(current, old);
          if (!matches) throw new Error(`old_string was not found in ${host.name}:${path}.`);
          if (matches > 1 && !args.replace_all) throw new Error(`old_string matches ${matches} occurrences in ${host.name}:${path}; include more surrounding context or set replace_all=true.`);
          return { content: Buffer.from(args.replace_all ? current.split(old).join(next) : current.replace(old, () => next)), replacements: args.replace_all ? matches : 1 };
        } });
    },
    presentCall: (args) => ({ card: "generic", kind: "edit", title: `Edit ${shortText(args?.host, "remote host")}:${shortText(args?.path, "file")}` }),
  });
  const remoteRestore = defineTool({
    name: "remote_restore",
    description: "Restore an existing remote file from a private durable backup_id. Always uses the mutation approval gate with Diff and exact original host/path binding. Refuses when the current file differs from the version written by the backed-up change; cannot restore a newly created file by deleting it. Saves another backup for the restore itself, preserves mode/uid/gid, and revalidates after approval. Optional verification is independently reviewed and runs once, with no automatic reload or rollback. SFTP cannot prevent all external-writer races.",
    parameters: {
      host: { type: "string", required: true, description: "Exact original host name from remote_hosts." },
      backup_id: { type: "string", required: true, description: "Backup ID returned by remote_write/edit or error.change." },
      ...verificationParameters,
    },
    output: { schema: { type: "json" }, render: render.remote_restore ?? render.remote_write },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const guardContext = captureGuard(host);
      assertSftpMutation?.(host);
      return fileChanges.restore({ host, backupId: args.backup_id, exec, guardContext, ...verificationOptions(args) });
    },
    presentCall: (args) => ({ card: "generic", kind: "edit", title: `Restore backup on ${shortText(args?.host, "remote host")}` }),
  });

  return [remoteWrite, remoteEdit, remoteRestore];
}
