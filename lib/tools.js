/**
 * The eight model-facing tools of dsh-remote.
 *
 * `createTools()` is pure wiring: the DSH `defineTool` factory and every runtime
 * dependency (config, transport, hosts store, approval gate, session cwd
 * resolver) are injected by `lib/index.js`, so this module imports neither
 * `@deepseek-ai/*` nor any SSH implementation and is testable with fakes.
 *
 * Contract: docs/ARCHITECTURE.md — "Tool surface", "Addendum: createTools
 * contract" and the "Canonical values" list. Every tool resolves its host
 * through the hosts store, enforces the allowHosts policy, bounds its output,
 * forwards `exec.signal` to every transport call, and asks the approval gate
 * before changing remote state.
 */

import { mkdir, readFile, stat as localStat, writeFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import {
  assessCommand,
  authHintFor,
  countOccurrences,
  createRenderers,
  describeError,
  finiteNumber,
  normalizeEntryType,
  normalizePositiveInt,
  normalizeTimeout,
  oneLine,
  parseProbeInfo,
  positiveNumber,
  remoteCall,
  shortText,
  splitLines,
  throwIfAborted,
  wrapError,
} from "./render.js";

/** Default and maximum `limit` for remote_read (lines). */
const DEFAULT_READ_LIMIT = 2000;
const MAX_READ_LIMIT = 10_000;

/** Upper bound for one remote_list result (the full count is still reported). */
const MAX_LIST_ENTRIES = 2000;

/** One-shot, read-only probe command; every value is a fact from the remote side. */
const PROBE_COMMAND = [
  'printf "@@hostname@@%s\\n" "$(hostname 2>/dev/null || uname -n 2>/dev/null)"',
  'printf "@@user@@%s\\n" "$(id -un 2>/dev/null || whoami 2>/dev/null)"',
  'printf "@@os@@%s\\n" "$(uname -s 2>/dev/null)"',
  'printf "@@kernel@@%s\\n" "$(uname -r 2>/dev/null)"',
  'printf "@@uptime@@%s\\n" "$(uptime 2>/dev/null | sed "s/^ *//")"',
  'printf "@@load@@%s\\n" "$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null)"',
  'printf "@@memory@@%s\\n" "$(free -h 2>/dev/null | sed -n "2p" || vm_stat 2>/dev/null | sed -n "1p")"',
  'printf "@@diskRoot@@%s\\n" "$(df -h / 2>/dev/null | sed -n "2p")"',
].join("; ");

/**
 * Create the dsh-remote tool definitions.
 *
 * @param {object} deps
 * @param {Function} deps.defineTool `@deepseek-ai/dsh-tools` factory (injected).
 * @param {object} deps.config Normalized dsh-remote config.
 * @param {object} deps.transport SSH transport ("Transport contract").
 * @param {object} deps.hosts Host store `{ list, find, isAllowed, isReadonly }`.
 * @param {object} deps.approval Approval gate `{ assessCommand, authorize }`.
 * @param {object} [deps.live] Live command hub `{ begin }` for the right-sidebar terminal.
 * @param {(exec: object) => Promise<string>} deps.cwdOf Session working-directory resolver.
 * @param {{ debug?: Function, info?: Function, warn?: Function }} [deps.logger]
 * @returns {object[]} Eight registry-ready ToolDefinitions, in protocol order.
 */
export function createTools(deps = {}) {
  const { defineTool, config, transport, hosts, approval, cwdOf, live, logger } = deps ?? {};
  for (const [name, value] of Object.entries({ config, transport, hosts, approval })) {
    if (typeof value !== "object" || value === null) throw new Error(`createTools: ${name} is required.`);
  }
  if (typeof defineTool !== "function") throw new Error("createTools: defineTool is required.");
  if (typeof cwdOf !== "function") throw new Error("createTools: cwdOf is required.");

  const render = createRenderers(config);
  const maxOutputBytes = positiveNumber(config.maxOutputBytes, 200_000);
  const maxReadBytes = positiveNumber(config.maxReadBytes, 800_000);
  const maxTransferBytes = positiveNumber(config.maxTransferBytes, 52_428_800);
  const execTimeoutMs = positiveNumber(config.execTimeoutMs, 120_000);
  const connectTimeoutMs = positiveNumber(config.connectTimeoutMs, 20_000);

  // --- shared plumbing -------------------------------------------------------

  /** Resolve a host name and enforce allowHosts. */
  async function prepareHost(query) {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("A host name is required. Call remote_hosts to list available hosts.");
    }
    const host = await hosts.find(query.trim());
    if (host === null || host === undefined) {
      throw new Error(`Unknown remote host ${JSON.stringify(query)}. Call remote_hosts to list available hosts.`);
    }
    if (!hosts.isAllowed(host)) {
      const error = new Error(
        `Remote host ${JSON.stringify(host.name)} is not permitted by the allowHosts policy; call remote_hosts to see permitted hosts.`,
      );
      error.code = "HOST_NOT_ALLOWED";
      throw error;
    }
    if (host.viaHost) {
      throw Object.assign(new Error(`Host ${host.name} is a terminal-only cluster shortcut via ${host.viaHost}. Use remote_shell_open/send/read on its shared PTY; remote exec, probe and SFTP would operate on the entry host and are disabled.`), { code: "TERMINAL_ONLY_HOST" });
    }
    return host;
  }

  /** Expand a leading `~`/`~/…` against the remote user's home directory. */
  async function expandRemotePath(host, rawPath, exec) {
    const path = typeof rawPath === "string" ? rawPath.trim() : "";
    if (path.length === 0) throw new Error("A remote path is required and must be a non-empty string.");
    if (path !== "~" && !path.startsWith("~/")) {
      if (path.startsWith("~")) {
        throw new Error(`Remote path ${JSON.stringify(path)} uses ~user expansion, which is not supported; use ~/… or an absolute path.`);
      }
      return path;
    }
    let home;
    try {
      home = await transport.homeDir(host, { signal: exec?.signal });
    } catch (error) {
      throw wrapError(`Could not resolve the remote home directory on ${host.name}`, error);
    }
    if (typeof home !== "string" || home.trim().length === 0) {
      throw new Error(`The remote home directory on ${host.name} is unavailable; pass an absolute path instead.`);
    }
    const suffix = path === "~" ? "" : path.slice(2);
    return suffix.length === 0 ? home : posix.join(home, suffix);
  }

  /** Ask approval for one action; a denial becomes a tool error. */
  async function authorizeAction({ toolName, exec, host, action, subject, mutating, unproven = false, verb, description }) {
    const decision = await approval.authorize({
      toolName,
      exec,
      host,
      action,
      subject,
      mutating,
      unproven,
      verb,
      description,
      // The gate itself only denies read-only hosts when the action is not
      // proven read-only, so passing the host flag is always truthful.
      readonlyHost: hosts.isReadonly(host),
    });
    if (decision === null || decision === undefined || decision.allowed !== true) {
      const reason =
        typeof decision?.reason === "string" && decision.reason.length > 0
          ? decision.reason
          : `Remote ${action} on ${host.name} was denied by the approval policy.`;
      logger?.warn?.(`dsh-remote: ${toolName} denied: ${reason}`);
      const error = new Error(reason);
      error.code = "DENIED";
      if (decision?.outcome !== undefined) error.outcome = decision.outcome;
      throw error;
    }
  }

  /** `transport.stat`, mapping ENOENT to null. */
  async function statOrNull(host, path, exec) {
    try {
      return await transport.stat(host, path, { signal: exec?.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.code === "ENOENT") return null;
      throw wrapError(`Could not stat ${host.name}:${path}`, error);
    }
  }

  /** Resolve local_path against the workspace and enforce the workspace restriction. */
  function resolveLocalPath(rawPath, workspace) {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("local_path is required and must be a non-empty string.");
    }
    const absolute = resolve(workspace, rawPath.trim());
    if (config.allowLocalOutsideWorkspace === true) return absolute;
    const relativePath = relative(workspace, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(
        `local_path ${JSON.stringify(rawPath)} resolves outside the session workspace (${absolute}); local paths must stay inside the workspace unless allowLocalOutsideWorkspace is enabled.`,
      );
    }
    return absolute;
  }

  /** Absolute session workspace root. */
  async function resolveWorkspace(exec) {
    let cwd;
    try {
      cwd = await cwdOf(exec);
    } catch (error) {
      throw wrapError("Could not resolve the session working directory", error);
    }
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      throw new Error("The session working directory is unavailable; cannot resolve local_path.");
    }
    return isAbsolute(cwd) ? cwd : resolve(cwd);
  }

  /** Local filesystem stat; ENOENT maps to null. */
  async function localStatOrNull(path, exec) {
    throwIfAborted(exec?.signal);
    try {
      return await localStat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw wrapError(`Could not stat the local path ${path}`, error);
    }
  }

  // --- 1. remote_hosts -------------------------------------------------------

  const remoteHosts = defineTool({
    name: "remote_hosts",
    description:
      "List the remote hosts available in this session (from ~/.ssh/config plus the plugin configuration). Read-only: never requires approval and changes nothing. Call this first when a host name is unknown: the NAME column is the exact lookup key for every other remote tool. By default only hosts permitted by the allowHosts policy are listed; set all=true to also list hosts blocked by allowHosts (marked, and still unusable). Each row reports name, user@host:port, source, read-only status, tags, and description, followed by the current approval policy. Output is bounded; if a needed host is missing, ask the user to add it instead of guessing a name.",
    parameters: {
      all: { type: "boolean", description: "When true, also list hosts blocked by the allowHosts policy (they remain unusable)." },
    },
    output: { schema: { type: "json" }, render: render.remote_hosts },
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const all = args.all === true;
      const discovered = await hosts.list({});
      const sorted = [...(Array.isArray(discovered) ? discovered : [])].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      const included = all ? sorted : sorted.filter((host) => hosts.isAllowed(host));
      return {
        total: included.length,
        blocked: sorted.length - included.length,
        discovered: sorted.length,
        hosts: included.map((host) => ({
          name: host.name,
          host: host.host,
          port: host.port ?? 22,
          username: host.username ?? null,
          source: host.source,
          readonly: hosts.isReadonly(host),
          authHint: authHintFor(host),
          ...(host.viaHost ? { viaHost: host.viaHost, actionCount: host.actions?.length ?? 0, terminalOnly: true,
            description: `${host.description ? host.description + "; " : ""}terminal-only via ${host.viaHost}; ${host.actions?.length ?? 0} ordered initialization actions; use remote_shell_* only` }
            : typeof host.description === "string" && host.description.length > 0 ? { description: host.description } : {}),
          ...(Array.isArray(host.tags) && host.tags.length > 0 ? { tags: [...host.tags] } : {}),
          ...(all ? { allowed: hosts.isAllowed(host) } : {}),
        })),
      };
    },
    presentCall: (args) => ({ card: "generic", kind: "read", title: args?.all === true ? "List all remote hosts" : "List remote hosts" }),
  });

  // --- 2. remote_probe -------------------------------------------------------

  const remoteProbe = defineTool({
    name: "remote_probe",
    description:
      "Test connectivity to one remote host over SSH and report basic facts: hostname, login user, OS, kernel, uptime, load, memory, and root-disk usage. Read-only: never requires approval and never mutates the host. Arguments in order: host (required, the exact name reported by remote_hosts). Use this before a first command on an unfamiliar or possibly unreachable host. Connection failures are returned as ok=false with a warning instead of a thrown error; a host blocked by allowHosts is rejected. Facts the remote shell cannot provide are omitted.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts to probe." },
    },
    output: { schema: { type: "json" }, render: render.remote_probe },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      throwIfAborted(exec?.signal);

      let test;
      try {
        test = await transport.test(host, { signal: exec.signal, timeoutMs: connectTimeoutMs });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        test = { ok: false, latencyMs: 0, error };
      }
      const latencyMs = finiteNumber(test?.latencyMs, 0);
      const banner = typeof test?.banner === "string" && test.banner.length > 0 ? test.banner : undefined;
      const warnings = [];
      if (test?.ok !== true) {
        warnings.push(describeError(test?.error) || "connectivity test failed");
        return { host: host.name, ok: false, latencyMs, ...(banner === undefined ? {} : { banner }), warnings };
      }

      let info = {};
      try {
        const result = await transport.exec(host, {
          command: PROBE_COMMAND,
          timeoutMs: execTimeoutMs,
          maxBytes: maxOutputBytes,
          signal: exec.signal,
        });
        info = parseProbeInfo(result?.stdout);
        if (result?.timedOut === true) warnings.push(`fact collection timed out after ${finiteNumber(result?.durationMs, 0)}ms`);
        else if (finiteNumber(result?.code, 0) !== 0) warnings.push(`fact collection exited with code ${result.code}`);
        if (result?.truncated === true) warnings.push("fact collection output was truncated");
        if (typeof result?.stderr === "string" && result.stderr.trim().length > 0) {
          warnings.push(`fact collection stderr: ${oneLine(result.stderr)}`);
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        warnings.push(`fact collection failed: ${describeError(error)}`);
      }
      return { host: host.name, ok: true, latencyMs, ...(banner === undefined ? {} : { banner }), info, warnings };
    },
    presentCall: (args) => ({ card: "generic", kind: "fetch", title: `Probe ${shortText(args?.host, "remote host")}` }),
  });

  // --- 3. remote_exec --------------------------------------------------------

  const remoteExec = defineTool({
    name: "remote_exec",
    description:
      "Run one non-interactive shell command on a remote host over SSH and return the exit code, stdout, and stderr. There is no PTY and no persistent session: every call starts a fresh shell, so pass workdir instead of cd and start long-running processes detached. Arguments in order: description (required, one short sentence for the approval prompt), host (required, exact name from remote_hosts), command (required, the shell line), workdir (optional remote directory, ~ allowed), timeout_ms (optional, defaults to the configured exec timeout). Approval: statically read-only commands run without asking under auto; mutating or unknown commands need approval; under always every command asks; under never mutating commands are denied; a read-only host accepts only statically read-only commands. A non-zero exit code is a normal result — check the [exit code: N] marker. Each stream is capped with a truncation marker; use remote_read for large files.",
    parameters: {
      description: { type: "string", required: true, description: "One short sentence describing the command; shown in the approval prompt." },
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      command: { type: "string", required: true, description: "Shell command line to run on the remote host (one-shot, non-interactive, no PTY)." },
      workdir: { type: "string", description: "Remote working directory; ~ expands to the remote home directory." },
      timeout_ms: { type: "integer", description: "Command timeout in milliseconds; defaults to the configured exec timeout." },
    },
    output: { schema: { type: "json" }, render: render.remote_exec },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (command.length === 0) throw new Error("command is required and must be a non-empty string.");
      const timeoutMs = normalizeTimeout(args.timeout_ms, execTimeoutMs);

      const assessment = assessCommand(approval, command);
      const mutating = assessment.level === "high";
      const unproven = assessment.level === "gray";
      const startedAt = Date.now();
      const liveCommand = beginLive(live, {
        sessionId: sessionIdOf(exec),
        tool: "remote_exec",
        host: host.name,
        command,
        kind: "exec",
      });
      try {
        if (typeof assessment.denied === "string" && assessment.denied.length > 0) {
          const error = new Error(`Remote command denied on ${host.name}: ${assessment.denied}.`);
          error.code = "DENIED";
          throw error;
        }
        await authorizeAction({
          toolName: "remote_exec",
          exec,
          host,
          action: "execute",
          subject: command,
          mutating,
          unproven,
          verb: assessment.verb,
          description: typeof args.description === "string" ? args.description : undefined,
        });
        throwIfAborted(exec?.signal);

        const workdir = args.workdir === undefined ? undefined : await expandRemotePath(host, args.workdir, exec);
        let result;
        try {
          result = await transport.exec(host, {
            command,
            ...(workdir === undefined ? {} : { workdir }),
            timeoutMs,
            maxBytes: maxOutputBytes,
            signal: exec.signal,
            ...(liveCommand === undefined
              ? {}
              : { onData: (event) => liveCommand.output(event?.stream, event?.chunk) }),
          });
        } catch (error) {
          throw wrapError(`Remote command failed on ${host.name}`, error);
        }
        const value = {
          host: host.name,
          command,
          exitCode: finiteNumber(result?.code, -1),
          signal: result?.signal ?? null,
          stdout: typeof result?.stdout === "string" ? result.stdout : "",
          stderr: typeof result?.stderr === "string" ? result.stderr : "",
          truncated: result?.truncated === true,
          timedOut: result?.timedOut === true,
          durationMs: finiteNumber(result?.durationMs, 0),
        };
        liveCommand?.end({ code: value.exitCode, durationMs: Date.now() - startedAt });
        return value;
      } catch (error) {
        liveCommand?.end({ error: describeError(error), durationMs: Date.now() - startedAt });
        throw error;
      }
    },
    presentCall: (args) => ({
      card: "generic",
      kind: "execute",
      title: `Run on ${shortText(args?.host, "remote host")}: ${shortText(args?.command, "command")}`,
    }),
  });

  // --- 4. remote_read --------------------------------------------------------

  const remoteRead = defineTool({
    name: "remote_read",
    description:
      "Read a remote file as bounded, line-numbered text. Read-only: never requires approval and never mutates the file. Arguments in order: host (required), path (required, remote path; ~ expands to the remote home directory), offset (optional 1-based first line, default 1), limit (optional maximum lines, default 2000). The header reports host, path, returned line range, total lines read, and file size; each body line is prefixed '<n>: '. The file is capped at the configured read byte limit and a [truncated; continue with offset N] marker gives the next offset. Use remote_list for directories and remote_transfer for large or binary files.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote file path; ~ expands to the remote home directory." },
      offset: { type: "integer", description: "1-based line number to start at; defaults to 1." },
      limit: { type: "integer", description: "Maximum number of lines to return; defaults to 2000." },
    },
    output: { schema: { type: "json" }, render: render.remote_read },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const remotePath = await expandRemotePath(host, args.path, exec);
      const offset = normalizePositiveInt(args.offset, 1, "offset");
      const limit = normalizePositiveInt(args.limit, DEFAULT_READ_LIMIT, "limit", MAX_READ_LIMIT);
      throwIfAborted(exec?.signal);

      const info = await remoteCall(`Could not stat ${host.name}:${remotePath}`, () =>
        transport.stat(host, remotePath, { signal: exec.signal }),
      );
      if (info?.type === "dir") {
        throw new Error(`Cannot read ${remotePath} on ${host.name}: it is a directory; use remote_list instead.`);
      }
      if (info?.type !== "file" && info?.type !== "symlink") {
        throw new Error(`Cannot read ${remotePath} on ${host.name}: remote type is ${JSON.stringify(info?.type ?? "unknown")}; only regular files can be read.`);
      }

      const read = await remoteCall(`Could not read ${host.name}:${remotePath}`, () =>
        transport.readFile(host, remotePath, { maxBytes: maxReadBytes, signal: exec.signal }),
      );
      const buffer = Buffer.isBuffer(read?.content) ? read.content : Buffer.from(read?.content ?? "");
      const size = finiteNumber(read?.size, finiteNumber(info?.size, buffer.length));
      const truncated = read?.truncated === true || size > buffer.length;
      let body = buffer.toString("utf8");
      if (truncated && !body.endsWith("\n")) {
        const lastNewline = body.lastIndexOf("\n");
        body = lastNewline === -1 ? "" : body.slice(0, lastNewline + 1);
      }
      const allLines = splitLines(body);
      const startIndex = offset - 1;
      const windowLines = allLines.slice(startIndex, startIndex + limit);
      const value = {
        host: host.name,
        path: remotePath,
        content: windowLines.join("\n"),
        lineCount: allLines.length,
        offset,
        limit,
        size,
        truncated,
      };
      if (windowLines.length > 0 && (startIndex + windowLines.length < allLines.length || truncated)) {
        value.nextOffset = offset + windowLines.length;
      }
      return value;
    },
    presentCall: (args) => ({ card: "generic", kind: "read", title: `Read ${shortText(args?.host, "remote host")}:${shortText(args?.path, "file")}` }),
  });

  // --- 5. remote_list --------------------------------------------------------

  const remoteList = defineTool({
    name: "remote_list",
    description:
      "List the entries of one remote directory. Read-only: never requires approval and changes nothing. Arguments in order: host (required), path (required, remote directory; ~ expands to the remote home directory). Each line reports type (dir/file/symlink/other), size in bytes, modification time, and name; entries are sorted by name and the output is bounded (the header reports the full count). Use this instead of running ls through remote_exec.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote directory path; ~ expands to the remote home directory." },
    },
    output: { schema: { type: "json" }, render: render.remote_list },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const remotePath = await expandRemotePath(host, args.path, exec);
      throwIfAborted(exec?.signal);
      const listing = await remoteCall(`Could not list ${host.name}:${remotePath}`, () =>
        transport.listDir(host, remotePath, { signal: exec.signal }),
      );
      const entries = (Array.isArray(listing) ? listing : [])
        .map((entry) => ({
          name: String(entry?.name ?? ""),
          type: normalizeEntryType(entry?.type),
          size: finiteNumber(entry?.size, 0),
          mtimeMs: finiteNumber(entry?.mtimeMs, 0),
          mode: finiteNumber(entry?.mode, 0),
        }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      return { host: host.name, path: remotePath, total: entries.length, entries: entries.slice(0, MAX_LIST_ENTRIES) };
    },
    presentCall: (args) => ({ card: "generic", kind: "read", title: `List ${shortText(args?.host, "remote host")}:${shortText(args?.path, "dir")}` }),
  });

  // --- 6. remote_write -------------------------------------------------------

  const remoteWrite = defineTool({
    name: "remote_write",
    description:
      "Create or replace a remote file with exact UTF-8 content. Mutating: always requires approval under auto/always, is denied under the never policy, and is denied on read-only hosts. Arguments in order: host (required), path (required; ~ expands to the remote home directory), content (required, complete new file content), create_dirs (optional boolean, default false, creates missing parent directories). The write is atomic (temp file + rename); when it replaces an existing file its permission mode is preserved. Reports the path, bytes written, and whether the file was created. For targeted changes to an existing file prefer remote_edit.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote file path; ~ expands to the remote home directory." },
      content: { type: "string", required: true, description: "Complete UTF-8 content of the new file." },
      create_dirs: { type: "boolean", description: "Create missing parent directories; defaults to false." },
    },
    output: { schema: { type: "json" }, render: render.remote_write },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const remotePath = await expandRemotePath(host, args.path, exec);
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      throwIfAborted(exec?.signal);

      const existing = await statOrNull(host, remotePath, exec);
      if (existing !== null && existing.type === "dir") {
        throw new Error(`Cannot write ${remotePath} on ${host.name}: it is a directory.`);
      }
      await authorizeAction({ toolName: "remote_write", exec, host, action: "write", subject: remotePath, mutating: true });
      throwIfAborted(exec?.signal);

      const buffer = Buffer.from(content, "utf8");
      const options = { signal: exec.signal, createDirs: args.create_dirs === true };
      const created = existing === null;
      if (!created && Number.isFinite(existing.mode)) options.mode = existing.mode;
      const written = await remoteCall(`Could not write ${host.name}:${remotePath}`, () =>
        transport.writeFile(host, remotePath, buffer, options),
      );
      if (options.mode !== undefined) {
        await remoteCall(`Could not restore the mode of ${host.name}:${remotePath}`, () =>
          transport.chmod(host, remotePath, options.mode, { signal: exec.signal }),
        );
      }
      return {
        host: host.name,
        path: remotePath,
        bytesWritten: finiteNumber(written?.bytesWritten, buffer.length),
        created,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      };
    },
    presentCall: (args) => ({ card: "generic", kind: "edit", title: `Write ${shortText(args?.host, "remote host")}:${shortText(args?.path, "file")}` }),
  });

  // --- 7. remote_edit --------------------------------------------------------

  const remoteEdit = defineTool({
    name: "remote_edit",
    description:
      "Replace one exact string in an existing remote file. Mutating: always requires approval under auto/always, is denied under the never policy, and is denied on read-only hosts. Arguments in order: host (required), path (required; ~ expands to the remote home directory), old_string (required, exact text including indentation), new_string (required, replacement text), replace_all (optional boolean, default false). The file is read before writing: the call fails when old_string is absent, when it matches more than once without replace_all=true, or when the file is too large to edit safely. The existing permission mode is preserved and the write is atomic.",
    parameters: {
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      path: { type: "string", required: true, description: "Remote file path; ~ expands to the remote home directory." },
      old_string: { type: "string", required: true, description: "Exact text to find, including whitespace and indentation." },
      new_string: { type: "string", required: true, description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence; defaults to false (exactly one match allowed)." },
    },
    output: { schema: { type: "json" }, render: render.remote_edit },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const remotePath = await expandRemotePath(host, args.path, exec);
      const oldString = typeof args.old_string === "string" ? args.old_string : "";
      const newString = typeof args.new_string === "string" ? args.new_string : "";
      if (oldString.length === 0) throw new Error("old_string is required and must not be empty.");
      if (oldString === newString) throw new Error("old_string and new_string are identical; nothing to change.");
      const replaceAll = args.replace_all === true;
      throwIfAborted(exec?.signal);

      const existing = await statOrNull(host, remotePath, exec);
      if (existing === null) {
        throw new Error(`Remote file not found: ${host.name}:${remotePath}. remote_edit only edits existing files; use remote_write to create one.`);
      }
      if (existing.type === "dir") throw new Error(`Cannot edit ${remotePath} on ${host.name}: it is a directory.`);

      const read = await remoteCall(`Could not read ${host.name}:${remotePath}`, () =>
        transport.readFile(host, remotePath, { maxBytes: maxReadBytes, signal: exec.signal }),
      );
      if (read?.truncated === true) {
        throw new Error(`Cannot edit ${remotePath} on ${host.name}: the file is larger than the configured read limit (${maxReadBytes} bytes).`);
      }
      const current = Buffer.isBuffer(read?.content) ? read.content.toString("utf8") : String(read?.content ?? "");
      const matches = countOccurrences(current, oldString);
      if (matches === 0) throw new Error(`old_string was not found in ${host.name}:${remotePath}.`);
      if (matches > 1 && !replaceAll) {
        throw new Error(`old_string matches ${matches} occurrences in ${host.name}:${remotePath}; include more surrounding context or set replace_all=true.`);
      }

      await authorizeAction({ toolName: "remote_edit", exec, host, action: "write", subject: remotePath, mutating: true });
      throwIfAborted(exec?.signal);

      const updated = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
      const buffer = Buffer.from(updated, "utf8");
      const mode = Number.isFinite(existing.mode) ? existing.mode : undefined;
      const options = { signal: exec.signal, createDirs: false, ...(mode === undefined ? {} : { mode }) };
      const written = await remoteCall(`Could not write ${host.name}:${remotePath}`, () =>
        transport.writeFile(host, remotePath, buffer, options),
      );
      if (mode !== undefined) {
        await remoteCall(`Could not restore the mode of ${host.name}:${remotePath}`, () =>
          transport.chmod(host, remotePath, mode, { signal: exec.signal }),
        );
      }
      return { host: host.name, path: remotePath, replacements: replaceAll ? matches : 1, bytesWritten: finiteNumber(written?.bytesWritten, buffer.length) };
    },
    presentCall: (args) => ({ card: "generic", kind: "edit", title: `Edit ${shortText(args?.host, "remote host")}:${shortText(args?.path, "file")}` }),
  });

  // --- 8. remote_transfer ----------------------------------------------------

  const remoteTransfer = defineTool({
    name: "remote_transfer",
    description:
      "Copy a file between the session workspace and a remote host. Mutating: always requires approval under auto/always, is denied under the never policy, and is denied on read-only hosts. Arguments in order: description (required, one short sentence for the approval prompt), host (required), direction (required: upload local→remote or download remote→local), local_path (required, resolved against the session workspace and kept inside it unless allowLocalOutsideWorkspace is enabled), remote_path (required; ~ expands to the remote home directory), overwrite (optional boolean, default false — an existing destination is never replaced without it). Both directions are capped at the configured transfer byte limit; larger files are refused instead of truncated. Paths are absolute in the result.",
    parameters: {
      description: { type: "string", required: true, description: "One short sentence describing the transfer; shown in the approval prompt." },
      host: { type: "string", required: true, description: "Host name from remote_hosts." },
      direction: { type: "string", required: true, enum: ["upload", "download"], description: "upload = local_path → remote_path; download = remote_path → local_path." },
      local_path: { type: "string", required: true, description: "Local path, resolved against the session workspace; must stay inside the workspace unless allowLocalOutsideWorkspace is enabled." },
      remote_path: { type: "string", required: true, description: "Remote file path; ~ expands to the remote home directory." },
      overwrite: { type: "boolean", description: "Replace an existing destination; defaults to false." },
    },
    output: { schema: { type: "json" }, render: render.remote_transfer },
    async execute(args, exec) {
      const host = await prepareHost(args.host);
      const direction = args.direction === "download" || args.direction === "upload" ? args.direction : undefined;
      if (direction === undefined) throw new Error('direction is required and must be "upload" or "download".');
      const overwrite = args.overwrite === true;
      const workspace = await resolveWorkspace(exec);
      const localPath = resolveLocalPath(args.local_path, workspace);
      const remotePath = await expandRemotePath(host, args.remote_path, exec);
      throwIfAborted(exec?.signal);
      const description = typeof args.description === "string" ? args.description : undefined;

      if (direction === "upload") {
        const local = await localStatOrNull(localPath, exec);
        if (local === null) throw new Error(`Local file not found: ${localPath}.`);
        if (!local.isFile()) throw new Error(`local_path is not a regular file: ${localPath}.`);
        if (local.size > maxTransferBytes) {
          throw new Error(`Local file ${localPath} is ${local.size} bytes, which exceeds the transfer limit of ${maxTransferBytes} bytes.`);
        }
        const remoteExisting = await statOrNull(host, remotePath, exec);
        if (remoteExisting !== null) {
          if (remoteExisting.type === "dir") throw new Error(`Cannot upload to ${host.name}:${remotePath}: it is a directory.`);
          if (!overwrite) throw new Error(`Remote file already exists: ${host.name}:${remotePath}; pass overwrite=true to replace it.`);
        }
        await authorizeAction({
          toolName: "remote_transfer",
          exec,
          host,
          action: "transfer",
          subject: `${localPath} -> ${remotePath}`,
          mutating: true,
          description,
        });
        throwIfAborted(exec?.signal);

        const started = Date.now();
        let data;
        try {
          data = await readFile(localPath, { signal: exec.signal });
        } catch (error) {
          throw wrapError(`Could not read the local file ${localPath}`, error);
        }
        if (data.length > maxTransferBytes) {
          throw new Error(`Local file ${localPath} grew beyond the transfer limit of ${maxTransferBytes} bytes.`);
        }
        const options = { signal: exec.signal, createDirs: false };
        if (remoteExisting !== null && Number.isFinite(remoteExisting.mode)) options.mode = remoteExisting.mode;
        const written = await remoteCall(`Could not upload to ${host.name}:${remotePath}`, () =>
          transport.writeFile(host, remotePath, data, options),
        );
        return { host: host.name, direction, localPath, remotePath, bytes: finiteNumber(written?.bytesWritten, data.length), durationMs: Date.now() - started };
      }

      const remoteExisting = await statOrNull(host, remotePath, exec);
      if (remoteExisting === null) throw new Error(`Remote file not found: ${host.name}:${remotePath}.`);
      if (remoteExisting.type === "dir") throw new Error(`Cannot download ${host.name}:${remotePath}: it is a directory.`);
      if (Number.isFinite(remoteExisting.size) && remoteExisting.size > maxTransferBytes) {
        throw new Error(`Remote file ${host.name}:${remotePath} is ${remoteExisting.size} bytes, which exceeds the transfer limit of ${maxTransferBytes} bytes.`);
      }
      const localExisting = await localStatOrNull(localPath, exec);
      if (localExisting !== null) {
        if (localExisting.isDirectory()) throw new Error(`Local destination is a directory: ${localPath}.`);
        if (!overwrite) throw new Error(`Local file already exists: ${localPath}; pass overwrite=true to replace it.`);
      }
      await authorizeAction({
        toolName: "remote_transfer",
        exec,
        host,
        action: "transfer",
        subject: `${localPath} <- ${remotePath}`,
        mutating: true,
        description,
      });
      throwIfAborted(exec?.signal);

      const started = Date.now();
      const read = await remoteCall(`Could not read ${host.name}:${remotePath}`, () =>
        transport.readFile(host, remotePath, { maxBytes: maxTransferBytes, signal: exec.signal }),
      );
      const data = Buffer.isBuffer(read?.content) ? read.content : Buffer.from(read?.content ?? "");
      if (read?.truncated === true) {
        throw new Error(`Remote file ${host.name}:${remotePath} exceeds the transfer limit of ${maxTransferBytes} bytes; refusing to write a partial file.`);
      }
      try {
        await mkdir(resolve(localPath, ".."), { recursive: true });
        await writeFile(localPath, data, { signal: exec.signal });
      } catch (error) {
        throw wrapError(`Could not write the local file ${localPath}`, error);
      }
      return { host: host.name, direction, localPath, remotePath, bytes: data.length, durationMs: Date.now() - started };
    },
    presentCall: (args) => {
      const action = args?.direction === "download" ? "Download from" : "Upload to";
      return { card: "generic", kind: "move", title: `${action} ${shortText(args?.host, "remote host")}: ${shortText(args?.remote_path, "file")}` };
    },
  });

  // Tool order is part of the model-facing protocol.
  return [remoteHosts, remoteProbe, remoteExec, remoteRead, remoteList, remoteWrite, remoteEdit, remoteTransfer];
}

/**
 * Agent/session identity for the live terminal. DSH stores the session on the
 * agent; a plain fake agent in tests only has an id.
 *
 * @param {any} exec
 * @returns {string|null}
 */
function sessionIdOf(exec) {
  const session = exec?.agent?.session ?? exec?.agent;
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Begin one live terminal command; returns undefined when no hub is mounted or
 * the hub rejects the input (the live mirror must never break the tool call).
 *
 * @param {any} live
 * @param {object} input
 * @returns {{ output: (stream: string, text: string) => void, end: (info?: object) => void } | undefined}
 */
function beginLive(live, input) {
  if (live === undefined || live === null || typeof live.begin !== "function") return undefined;
  try {
    return live.begin(input);
  } catch {
    return undefined;
  }
}

export { sessionIdOf, beginLive };
