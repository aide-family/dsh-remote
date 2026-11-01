/**
 * Integration tests for the dsh-remote tool surface (lib/tools.js + lib/render.js).
 *
 * Everything except the real `defineTool` from @deepseek-ai/dsh-tools is faked:
 * an in-memory transport, a host store over fixed records, an approval gate that
 * mirrors the documented contract, and a cwdOf returning a temp workspace. No
 * network, no SSH, no DSH runtime.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile as readLocal, rm, writeFile as writeLocal } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { createTools } from "../../lib/tools.js";

// ---------------------------------------------------------------------------
// Fixed fixtures
// ---------------------------------------------------------------------------

const TOOL_ORDER = [
  "remote_hosts",
  "remote_probe",
  "remote_exec",
  "remote_read",
  "remote_list",
  "remote_write",
  "remote_edit",
  "remote_transfer",
];

/** @returns {object} A normalized config with the documented defaults. */
function makeConfig(overrides = {}) {
  return {
    hosts: [],
    includeSshConfig: true,
    sshConfigPath: "~/.ssh/config",
    policy: "auto",
    readonlyHosts: [],
    allowHosts: [],
    denyCommandPatterns: [],
    connectTimeoutMs: 20_000,
    execTimeoutMs: 120_000,
    maxOutputBytes: 200_000,
    maxReadBytes: 800_000,
    maxTransferBytes: 52_428_800,
    knownHostsPolicy: "tofu",
    allowLocalOutsideWorkspace: false,
    promptGuidance: true,
    ...overrides,
  };
}

const DEFAULT_HOST_RECORDS = [
  {
    id: "config:prod-web-1",
    name: "prod-web-1",
    host: "10.0.0.11",
    port: 22,
    username: "ops",
    source: "config",
    identityFile: "~/.ssh/prod_ed25519",
    description: "primary web node",
    tags: ["prod", "web"],
    readonly: false,
    allowed: true,
  },
  {
    id: "ssh-config:staging-db",
    name: "staging-db",
    host: "10.0.0.12",
    port: 2222,
    username: "deploy",
    source: "ssh-config",
    readonly: true,
    allowed: true,
  },
  {
    id: "config:locked-box",
    name: "locked-box",
    host: "10.0.0.13",
    port: 22,
    username: "root",
    source: "config",
    readonly: false,
    allowed: false,
  },
];

/** @returns {object} Fake host store implementing the documented contract. */
function createFakeHosts(records = DEFAULT_HOST_RECORDS) {
  const hosts = records.map((record) => ({ ...record, tags: record.tags === undefined ? undefined : [...record.tags] }));
  const calls = [];
  return {
    calls,
    hosts,
    async list(options = {}) {
      calls.push({ method: "list", options });
      return hosts.map((host) => ({ ...host }));
    },
    async find(query) {
      calls.push({ method: "find", query });
      const host = hosts.find((candidate) => candidate.name === query);
      if (host === undefined) {
        const names = hosts.map((candidate) => candidate.name).slice(0, 20);
        const error = new Error(
          `Unknown remote host ${JSON.stringify(String(query))}. Available hosts: ${names.join(", ")}. Call remote_hosts to list hosts.`,
        );
        error.code = "UNKNOWN_HOST";
        throw error;
      }
      return host;
    },
    isAllowed(host) {
      return host.allowed !== false;
    },
    isReadonly(host) {
      return host.readonly === true;
    },
  };
}

/** @returns {object} Fake approval gate that mirrors lib/approval.js behaviour. */
function createFakeApproval(options = {}) {
  const calls = [];
  const policy = options.policy ?? "auto";
  const outcome = options.outcome ?? "allowed-once";
  const assess = options.assess ?? (() => ({ level: "high", verb: "rm" }));
  return {
    calls,
    assessCommand(command) {
      if (typeof options.assessCommand === "function") return options.assessCommand(command);
      return assess(command);
    },
    async authorize(request) {
      calls.push(request);
      if (typeof options.authorize === "function") return options.authorize(request);
      if (request.readonlyHost === true) {
        return {
          allowed: false,
          reason: `Host ${request.host.name} is configured read-only; ${request.action} is denied.`,
        };
      }
      if (request.mutating !== true && policy !== "always") return { allowed: true };
      if (policy === "never") {
        return {
          allowed: false,
          reason: `Approval policy is "never": remote ${request.action} on ${request.host.name} is denied.`,
        };
      }
      switch (outcome) {
        case "allowed-once":
          return { allowed: true, outcome };
        case "rejected":
          return { allowed: false, outcome, reason: `Remote ${request.action} on ${request.host.name} — rejected by the user.` };
        case "cancelled":
          return {
            allowed: false,
            outcome,
            reason: `Remote ${request.action} on ${request.host.name} — the approval request was cancelled.`,
          };
        case "unavailable":
          return {
            allowed: false,
            outcome,
            reason: `Remote ${request.action} on ${request.host.name} — denied because no approval answerer is available (fail closed).`,
          };
        default:
          return { allowed: false, outcome: "unavailable", reason: "unexpected approval outcome" };
      }
    },
  };
}

/** @returns {Error} */
function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * In-memory transport. `files` maps remote path → { content: Buffer|string,
 * mode?, mtimeMs? }; `entries` maps remote dir path → listDir entries.
 *
 * @returns {object} Fake transport.
 */
function createFakeTransport(options = {}) {
  const calls = [];
  const files = new Map();
  for (const [path, value] of Object.entries(options.files ?? {})) {
    files.set(path, normalizeFakeFile(value));
  }
  const entries = new Map(Object.entries(options.entries ?? {}));
  const home = typeof options.home === "string" ? options.home : "/home/ops";

  function record(method, host, extra = {}) {
    calls.push({ method, host: host?.name ?? host, ...extra });
  }

  return {
    calls,
    files,
    entries,
    home,
    async homeDir(host, callOptions) {
      record("homeDir", host, { options: callOptions });
      if (options.homeDirError === true) throw fsError("CONNECTION", "connection lost while resolving home");
      return home;
    },
    async test(host, callOptions) {
      record("test", host, { options: callOptions });
      if (typeof options.test === "function") return options.test(host, callOptions);
      return options.test ?? { ok: true, latencyMs: 12, banner: "SSH-2.0-OpenSSH_9.6" };
    },
    async exec(host, execOptions) {
      record("exec", host, { options: execOptions });
      if (typeof options.exec === "function") return options.exec(host, execOptions);
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 7,
      };
    },
    async stat(host, path, callOptions) {
      record("stat", host, { path, options: callOptions });
      if (typeof options.stat === "function") return options.stat(host, path, callOptions);
      const file = files.get(path);
      if (file !== undefined) {
        return {
          type: file.type ?? "file",
          size: file.content.length,
          mtimeMs: file.mtimeMs,
          mode: file.mode,
        };
      }
      if (entries.has(path)) return { type: "dir", size: 0, mtimeMs: 0, mode: 0o755 };
      throw fsError("ENOENT", `No such file or directory: ${path}`);
    },
    async readFile(host, path, callOptions) {
      record("readFile", host, { path, options: callOptions });
      if (typeof options.readFile === "function") return options.readFile(host, path, callOptions);
      const file = files.get(path);
      if (file === undefined) throw fsError("ENOENT", `No such file: ${path}`);
      let content = file.content;
      let truncated = false;
      const maxBytes = callOptions?.maxBytes;
      if (typeof maxBytes === "number" && content.length > maxBytes) {
        content = content.subarray(0, maxBytes);
        truncated = true;
      }
      return { content: Buffer.from(content), size: file.content.length, truncated };
    },
    async writeFile(host, path, content, callOptions) {
      const buffer = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content));
      record("writeFile", host, { path, content: buffer, options: callOptions });
      if (typeof options.writeFile === "function") return options.writeFile(host, path, buffer, callOptions);
      const existing = files.get(path);
      files.set(path, {
        type: "file",
        content: buffer,
        mode: callOptions?.mode ?? existing?.mode ?? 0o644,
        mtimeMs: 0,
      });
      return { bytesWritten: buffer.length };
    },
    async listDir(host, path, callOptions) {
      record("listDir", host, { path, options: callOptions });
      if (typeof options.listDir === "function") return options.listDir(host, path, callOptions);
      const listing = entries.get(path);
      if (listing === undefined) throw fsError("ENOENT", `No such directory: ${path}`);
      return listing.map((entry) => ({ ...entry }));
    },
    async mkdirp(host, path, callOptions) {
      record("mkdirp", host, { path, options: callOptions });
      return undefined;
    },
    async chmod(host, path, mode, callOptions) {
      record("chmod", host, { path, mode, options: callOptions });
      const file = files.get(path);
      if (file !== undefined) file.mode = mode;
      return undefined;
    },
    dispose() {
      record("dispose", undefined);
    },
  };
}

/** @returns {object} */
function normalizeFakeFile(value) {
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    return { type: "file", content: Buffer.from(value), mode: 0o644, mtimeMs: 1_700_000_000_000 };
  }
  return {
    type: value.type ?? "file",
    content: Buffer.from(value.content ?? ""),
    mode: value.mode ?? 0o644,
    mtimeMs: value.mtimeMs ?? 1_700_000_000_000,
  };
}

/** @returns {object} Fake tool execution context. */
function makeExec(overrides = {}) {
  return {
    agent: { id: "test-agent" },
    callId: "call-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Build one wired tool set plus its fakes.
 *
 * @param {object} [options]
 * @returns {object}
 */
function makeHarness(options = {}) {
  const config = makeConfig(options.config);
  const transport = options.transport ?? createFakeTransport(options.transportOptions);
  const hosts = options.hosts ?? createFakeHosts(options.hostRecords);
  const approval = options.approval ?? createFakeApproval(options.approvalOptions);
  const workspace = options.workspace ?? process.cwd();
  const cwdOf = options.cwdOf ?? (async () => workspace);
  const exec = options.exec ?? makeExec();
  const tools = createTools({ defineTool, config, transport, hosts, approval, cwdOf, logger: options.logger });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { config, transport, hosts, approval, tools, byName, exec, workspace };
}

/** @returns {Promise<any>} */
async function run(harness, toolName, args, exec = harness.exec) {
  return harness.byName[toolName].execute(args, exec);
}

/** @returns {string} Rendered text for one execution result. */
function renderText(harness, toolName, args, value) {
  const blocks = harness.byName[toolName].output.render(args, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  return blocks[0].text;
}

/** @returns {Promise<{root: string, workspace: string}>} */
async function makeTempWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-remote-tools-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace };
}

/** A canned probe shell output. */
const PROBE_STDOUT = [
  "@@hostname@@web-1",
  "@@user@@ops",
  "@@os@@Linux",
  "@@kernel@@6.8.0-45-generic",
  "@@uptime@@up 3 days, 2:11",
  "@@load@@0.12 0.08 0.02 1/234 1234",
  "@@memory@@Mem: 3.8Gi 1.2Gi 2.4Gi",
  "@@diskRoot@@/dev/sda1 40G 12G 26G 32% /",
].join("\n");

/** @returns {object} A successful probe exec result. */
function probeExecResult() {
  return {
    code: 0,
    signal: null,
    stdout: PROBE_STDOUT,
    stderr: "",
    stdoutBytes: PROBE_STDOUT.length,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    durationMs: 9,
  };
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

test("createTools returns the eight tools in protocol order with complete definitions", () => {
  const harness = makeHarness();
  assert.deepEqual(
    harness.tools.map((tool) => tool.name),
    TOOL_ORDER,
  );
  for (const tool of harness.tools) {
    assert.equal(typeof tool.description, "string", `${tool.name} has a description`);
    assert.ok(tool.description.length > 100, `${tool.name} description is model-facing detail`);
    assert.equal(tool.parameters.type, "object");
    assert.equal(typeof tool.parameters.properties, "object");
    assert.equal(typeof tool.output.render, "function", `${tool.name} has a renderer`);
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.presentCall, "function", `${tool.name} has presentCall`);
  }
});

test("parameter schemas declare required arguments in documented order", () => {
  const { byName } = makeHarness();
  assert.deepEqual(byName.remote_exec.parameters.required, ["description", "host", "command"]);
  assert.deepEqual(Object.keys(byName.remote_exec.parameters.properties), [
    "description",
    "host",
    "command",
    "workdir",
    "timeout_ms",
  ]);
  assert.deepEqual(byName.remote_read.parameters.required, ["host", "path"]);
  assert.deepEqual(byName.remote_write.parameters.required, ["host", "path", "content"]);
  assert.deepEqual(byName.remote_edit.parameters.required, ["host", "path", "old_string", "new_string"]);
  assert.deepEqual(byName.remote_transfer.parameters.required, [
    "description",
    "host",
    "direction",
    "local_path",
    "remote_path",
  ]);
  assert.deepEqual(byName.remote_transfer.parameters.properties.direction.enum, ["upload", "download"]);
});

test("presentCall returns a generic card with a kind and short title for every tool", () => {
  const { byName } = makeHarness();
  const calls = {
    remote_hosts: [{}],
    remote_probe: [{ host: "prod-web-1" }],
    remote_exec: [{ description: "list", host: "prod-web-1", command: "ls -la" }],
    remote_read: [{ host: "prod-web-1", path: "/etc/nginx/nginx.conf" }],
    remote_list: [{ host: "prod-web-1", path: "/var/log" }],
    remote_write: [{ host: "prod-web-1", path: "/tmp/x", content: "x" }],
    remote_edit: [{ host: "prod-web-1", path: "/tmp/x", old_string: "a", new_string: "b" }],
    remote_transfer: [
      { description: "ship", host: "prod-web-1", direction: "upload", local_path: "a", remote_path: "/tmp/a" },
    ],
  };
  const kinds = new Set(["read", "edit", "delete", "move", "search", "execute", "fetch", "other"]);
  for (const [name, argList] of Object.entries(calls)) {
    const view = byName[name].presentCall(argList[0]);
    assert.equal(view.card, "generic");
    assert.equal(typeof view.title, "string");
    assert.ok(view.title.length > 0);
    assert.ok(kinds.has(view.kind), `${name} kind is in the allowed vocabulary`);
  }
});

test("createTools rejects a missing dependency instead of failing on the first call", () => {
  const deps = { defineTool, config: makeConfig(), transport: {}, hosts: {}, approval: {} };
  assert.throws(() => createTools(deps), /cwdOf/);
  assert.throws(() => createTools({ ...deps, cwdOf: async () => process.cwd(), defineTool: undefined }), /defineTool/);
});

// ---------------------------------------------------------------------------
// remote_hosts
// ---------------------------------------------------------------------------

test("remote_hosts lists allowed hosts with policy hints and hides blocked hosts", async () => {
  const harness = makeHarness();
  const value = await run(harness, "remote_hosts", {});
  assert.equal(value.total, 2);
  assert.equal(value.blocked, 1);
  assert.equal(value.discovered, 3);
  assert.deepEqual(
    value.hosts.map((host) => host.name),
    ["prod-web-1", "staging-db"],
  );
  const first = value.hosts[0];
  assert.equal(first.port, 22);
  assert.equal(first.username, "ops");
  assert.equal(first.source, "config");
  assert.equal(first.readonly, false);
  assert.equal(first.authHint, "publickey (identity file)");
  assert.deepEqual(first.tags, ["prod", "web"]);

  const text = renderText(harness, "remote_hosts", {}, value);
  assert.match(text, /2 remote hosts:/);
  assert.match(text, /NAME\s+TARGET/);
  assert.match(text, /prod-web-1\s+ops@10\.0\.0\.11:22/);
  assert.match(text, /staging-db\s+deploy@10\.0\.0\.12:2222/);
  assert.match(text, /read-only/);
  assert.match(text, /Approval policy: auto/);
  assert.match(text, /1 host hidden by allowHosts/);
});

test("remote_hosts all=true includes blocked hosts and marks them", async () => {
  const harness = makeHarness();
  const value = await run(harness, "remote_hosts", { all: true });
  assert.equal(value.total, 3);
  assert.equal(value.blocked, 0);
  const blocked = value.hosts.find((host) => host.name === "locked-box");
  assert.equal(blocked.allowed, false);
  const text = renderText(harness, "remote_hosts", { all: true }, value);
  assert.match(text, /blocked by allowHosts/);
});

test("remote_hosts empty store renders actionable guidance", async () => {
  const harness = makeHarness({ hostRecords: [] });
  const value = await run(harness, "remote_hosts", {});
  const text = renderText(harness, "remote_hosts", {}, value);
  assert.match(text, /No remote hosts are available\./);
  assert.match(text, /~\/\.ssh\/config/);
});

// ---------------------------------------------------------------------------
// remote_probe
// ---------------------------------------------------------------------------

test("remote_probe reports connectivity facts from the remote side", async () => {
  const harness = makeHarness({
    transportOptions: {
      test: { ok: true, latencyMs: 18, banner: "SSH-2.0-OpenSSH_9.6" },
      exec: () => probeExecResult(),
    },
  });
  const value = await run(harness, "remote_probe", { host: "prod-web-1" });
  assert.equal(value.ok, true);
  assert.equal(value.latencyMs, 18);
  assert.equal(value.banner, "SSH-2.0-OpenSSH_9.6");
  assert.equal(value.info.hostname, "web-1");
  assert.equal(value.info.user, "ops");
  assert.equal(value.info.kernel, "6.8.0-45-generic");
  assert.deepEqual(value.warnings, []);

  const text = renderText(harness, "remote_probe", { host: "prod-web-1" }, value);
  assert.match(text, /prod-web-1: ok \(18ms\)/);
  assert.match(text, /banner: SSH-2\.0-OpenSSH_9\.6/);
  assert.match(text, /hostname: web-1/);
  assert.match(text, /diskRoot: \/dev\/sda1/);

  const testCall = harness.transport.calls.find((call) => call.method === "test");
  assert.equal(testCall.options.signal, harness.exec.signal);
  const execCall = harness.transport.calls.find((call) => call.method === "exec");
  assert.match(execCall.options.command, /@@hostname@@/);
  assert.equal(execCall.options.maxBytes, 200_000);
  assert.equal(execCall.options.timeoutMs, 120_000);
});

test("remote_probe reports connection failure as ok=false instead of throwing", async () => {
  const harness = makeHarness({
    transportOptions: {
      test: { ok: false, latencyMs: 0, error: Object.assign(new Error("connect ECONNREFUSED"), { code: "CONNECT" }) },
    },
  });
  const value = await run(harness, "remote_probe", { host: "prod-web-1" });
  assert.equal(value.ok, false);
  assert.equal(value.warnings.length, 1);
  assert.match(value.warnings[0], /connect ECONNREFUSED \(code: CONNECT\)/);
  const text = renderText(harness, "remote_probe", { host: "prod-web-1" }, value);
  assert.match(text, /prod-web-1: unreachable/);
  assert.match(text, /warning: connect ECONNREFUSED/);
  assert.equal(
    harness.transport.calls.some((call) => call.method === "exec"),
    false,
  );
});

// ---------------------------------------------------------------------------
// remote_exec
// ---------------------------------------------------------------------------

test("remote_exec runs a statically read-only command without approval", async () => {
  const harness = makeHarness({
    approvalOptions: { assess: () => ({ level: "low", verb: "ls" }) },
    transportOptions: {
      exec: () => ({
        code: 0,
        signal: null,
        stdout: "total 0\nfile.txt\n",
        stderr: "",
        stdoutBytes: 20,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 11,
      }),
    },
  });
  const value = await run(harness, "remote_exec", {
    description: "list files",
    host: "prod-web-1",
    command: "ls -la",
  });
  assert.equal(harness.approval.calls.length, 1);
  assert.equal(harness.approval.calls[0].mutating, false);
  assert.equal(harness.approval.calls[0].action, "execute");
  assert.equal(value.exitCode, 0);
  assert.equal(value.stdout, "total 0\nfile.txt\n");
  assert.equal(value.timedOut, false);
  const call = harness.transport.calls.find((entry) => entry.method === "exec");
  assert.equal(call.options.command, "ls -la");
  assert.equal(call.options.maxBytes, 200_000);
  assert.equal(call.options.timeoutMs, 120_000);
  assert.equal(call.options.signal, harness.exec.signal);
  const text = renderText(harness, "remote_exec", {}, value);
  assert.equal(text, "[exit code: 0]\ntotal 0\nfile.txt");
});

test("remote_exec asks approval for a mutating command and proceeds on allowed-once", async () => {
  const harness = makeHarness({
    approvalOptions: { assess: () => ({ level: "high", verb: "rm" }) },
    transportOptions: {
      exec: () => ({
        code: 0,
        signal: null,
        stdout: "removed\n",
        stderr: "",
        stdoutBytes: 8,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 3,
      }),
    },
  });
  const value = await run(harness, "remote_exec", {
    description: "clean temp files",
    host: "prod-web-1",
    command: "rm -f /tmp/scratch",
  });
  assert.equal(value.exitCode, 0);
  assert.equal(harness.approval.calls.length, 1);
  const request = harness.approval.calls[0];
  assert.equal(request.toolName, "remote_exec");
  assert.equal(request.action, "execute");
  assert.equal(request.mutating, true);
  assert.equal(request.verb, "rm");
  assert.equal(request.subject, "rm -f /tmp/scratch");
  assert.equal(request.description, "clean temp files");
  assert.equal(request.readonlyHost, false);
  assert.equal(request.exec, harness.exec);
});

test("remote_exec respects timeout_ms and workdir, expanding ~ in workdir", async () => {
  const harness = makeHarness({ approvalOptions: { assess: () => ({ level: "low", verb: "pwd" }) } });
  await run(harness, "remote_exec", {
    description: "show cwd",
    host: "prod-web-1",
    command: "pwd",
    workdir: "~/app",
    timeout_ms: 5_000,
  });
  const call = harness.transport.calls.find((entry) => entry.method === "exec");
  assert.equal(call.options.workdir, "/home/ops/app");
  assert.equal(call.options.timeoutMs, 5_000);
  const homeCall = harness.transport.calls.find((entry) => entry.method === "homeDir");
  assert.equal(homeCall.options.signal, harness.exec.signal);
});

test("remote_exec keeps non-zero exits as normal results and renders them", async () => {
  const harness = makeHarness({
    approvalOptions: { assess: () => ({ level: "low", verb: "cat" }) },
    transportOptions: {
      exec: () => ({
        code: 2,
        signal: null,
        stdout: "",
        stderr: "cat: missing: No such file or directory\n",
        stdoutBytes: 0,
        stderrBytes: 39,
        truncated: false,
        timedOut: false,
        durationMs: 4,
      }),
    },
  });
  const value = await run(harness, "remote_exec", { description: "read", host: "prod-web-1", command: "cat missing" });
  assert.equal(value.exitCode, 2);
  const text = renderText(harness, "remote_exec", {}, value);
  assert.equal(text, "[exit code: 2]\n[stderr]\ncat: missing: No such file or directory");
});

test("remote_exec renders truncation, timeout and no-output markers", async () => {
  const harness = makeHarness({
    approvalOptions: { assess: () => ({ level: "high", verb: "dd" }) },
    transportOptions: {
      exec: () => ({
        code: -1,
        signal: "SIGTERM",
        stdout: "partial out\n",
        stderr: "partial err\n",
        stdoutBytes: 12,
        stderrBytes: 12,
        truncated: true,
        timedOut: true,
        durationMs: 250,
      }),
    },
  });
  const value = await run(harness, "remote_exec", { description: "dd", host: "prod-web-1", command: "dd if=/dev/zero" });
  const text = renderText(harness, "remote_exec", {}, value);
  assert.equal(text, "[exit code: -1]\npartial out\n[stderr]\npartial err\n[output truncated; each stream was capped at 200000 bytes (tail kept)]\n[timeout after 250ms]");
  assert.equal(value.signal, "SIGTERM");
  assert.equal(value.truncated, true);
  assert.equal(value.timedOut, true);
});

test("remote_exec reports [no output] for an empty successful command", async () => {
  const harness = makeHarness({ approvalOptions: { assess: () => ({ level: "low", verb: "true" }) } });
  const value = await run(harness, "remote_exec", { description: "true", host: "prod-web-1", command: "true" });
  assert.equal(renderText(harness, "remote_exec", {}, value), "[exit code: 0]\n[no output]");
});

test("remote_exec denies commands matched by denyCommandPatterns before approval", async () => {
  const harness = makeHarness({
    approvalOptions: {
      assessCommand: () => ({ level: "high", verb: "rm", denied: "command denied by denyCommandPatterns (rm -rf)" }),
    },
  });
  await assert.rejects(
    run(harness, "remote_exec", { description: "wipe", host: "prod-web-1", command: "rm -rf /" }),
    /denied by denyCommandPatterns/,
  );
  assert.equal(harness.approval.calls.length, 0);
  assert.equal(
    harness.transport.calls.some((call) => call.method === "exec"),
    false,
  );
});

test("remote_exec denial outcomes produce clear errors without running the command", async (t) => {
  const cases = [
    ["rejected", /rejected by the user/],
    ["cancelled", /approval request was cancelled/],
    ["unavailable", /fail closed/],
  ];
  for (const [outcome, pattern] of cases) {
    await t.test(outcome, async () => {
      const harness = makeHarness({
        approvalOptions: { outcome, assess: () => ({ level: "high", verb: "systemctl" }) },
      });
      await assert.rejects(
        run(harness, "remote_exec", {
          description: "restart",
          host: "prod-web-1",
          command: "systemctl restart nginx",
        }),
        pattern,
      );
      assert.equal(
        harness.transport.calls.some((call) => call.method === "exec"),
        false,
      );
    });
  }
});

test("every execute honors an already-aborted exec.signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = makeHarness({ exec: makeExec({ signal: controller.signal }) });
  await assert.rejects(
    run(harness, "remote_read", { host: "prod-web-1", path: "/home/ops/a.txt" }),
    (error) => error.name === "AbortError",
  );
  assert.equal(
    harness.transport.calls.some((call) => call.method === "stat"),
    false,
  );
});

// ---------------------------------------------------------------------------
// host policy
// ---------------------------------------------------------------------------

test("unknown host errors list the available names", async () => {
  const harness = makeHarness();
  await assert.rejects(run(harness, "remote_read", { host: "nope", path: "/tmp/a" }), (error) => {
    assert.match(error.message, /Unknown remote host "nope"/);
    assert.match(error.message, /Available hosts: prod-web-1, staging-db, locked-box/);
    return true;
  });
});

test("hosts blocked by allowHosts are rejected by every tool", async () => {
  const harness = makeHarness();
  await assert.rejects(run(harness, "remote_read", { host: "locked-box", path: "/etc/passwd" }), /allowHosts/);
  assert.equal(
    harness.transport.calls.some((call) => call.method === "stat"),
    false,
  );
});

test("read-only tools work on a read-only host without asking approval", async () => {
  const harness = makeHarness({
    hostRecords: DEFAULT_HOST_RECORDS.map((record) =>
      record.name === "staging-db" ? { ...record, readonly: true } : record,
    ),
    transportOptions: { home: "/home/deploy", files: { "/home/deploy/conf.txt": "a\nb\n" } },
  });
  const value = await run(harness, "remote_read", { host: "staging-db", path: "~/conf.txt" });
  assert.equal(value.path, "/home/deploy/conf.txt");
  assert.equal(harness.approval.calls.length, 0);
});

// ---------------------------------------------------------------------------
// remote_read
// ---------------------------------------------------------------------------

test("remote_read returns a numbered window with a continue offset", async () => {
  const body = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const harness = makeHarness({ transportOptions: { files: { "/home/ops/log.txt": body } } });
  const value = await run(harness, "remote_read", {
    host: "prod-web-1",
    path: "~/log.txt",
    offset: 4,
    limit: 3,
  });
  assert.equal(value.path, "/home/ops/log.txt");
  assert.equal(value.content, "line 4\nline 5\nline 6");
  assert.equal(value.lineCount, 10);
  assert.equal(value.offset, 4);
  assert.equal(value.limit, 3);
  assert.equal(value.size, Buffer.byteLength(body));
  assert.equal(value.truncated, false);
  assert.equal(value.nextOffset, 7);
  assert.equal(harness.approval.calls.length, 0);

  const text = renderText(harness, "remote_read", {}, value);
  assert.match(text, /^prod-web-1:\/home\/ops\/log\.txt \(lines 4-6 of 10; \d+ bytes\)$/m);
  assert.match(text, /^4: line 4$/m);
  assert.match(text, /^6: line 6$/m);
  assert.match(text, /\[truncated; continue with offset 7\]/);

  const readCall = harness.transport.calls.find((call) => call.method === "readFile");
  assert.equal(readCall.options.maxBytes, 800_000);
  assert.equal(readCall.options.signal, harness.exec.signal);
});

test("remote_read truncates at maxReadBytes and reports the next offset", async () => {
  const body = Array.from({ length: 50 }, (_, index) => `0123456789 line ${index}`).join("\n") + "\n";
  const harness = makeHarness({ config: { maxReadBytes: 120 }, transportOptions: { files: { "/home/ops/big.txt": body } } });
  const value = await run(harness, "remote_read", { host: "prod-web-1", path: "/home/ops/big.txt" });
  assert.equal(value.truncated, true);
  assert.equal(value.size, Buffer.byteLength(body));
  assert.ok(value.lineCount > 0);
  assert.equal(value.nextOffset, 1 + value.lineCount);
  assert.equal(value.content.includes("\uFFFD"), false, "no partial UTF-8 bytes are surfaced");

  const text = renderText(harness, "remote_read", {}, value);
  assert.match(text, /\[truncated; continue with offset \d+\]/);
  const readCall = harness.transport.calls.find((call) => call.method === "readFile");
  assert.equal(readCall.options.maxBytes, 120);
});

test("remote_read rejects directories and reports stat failures with codes", async () => {
  const harness = makeHarness({ transportOptions: { entries: { "/var/log": [] } } });
  await assert.rejects(run(harness, "remote_read", { host: "prod-web-1", path: "/var/log" }), /it is a directory/);

  const missing = makeHarness();
  await assert.rejects(
    run(missing, "remote_read", { host: "prod-web-1", path: "/nope.txt" }),
    /Could not stat prod-web-1:\/nope\.txt: No such file or directory: \/nope\.txt \(code: ENOENT\)/,
  );
});

test("remote_read renders an empty file cleanly", async () => {
  const harness = makeHarness({ transportOptions: { files: { "/home/ops/empty": "" } } });
  const value = await run(harness, "remote_read", { host: "prod-web-1", path: "/home/ops/empty" });
  const text = renderText(harness, "remote_read", {}, value);
  assert.match(text, /\(empty; 0 bytes\)/);
  assert.match(text, /\[no lines\]/);
});

// ---------------------------------------------------------------------------
// remote_list
// ---------------------------------------------------------------------------

test("remote_list sorts entries and renders type/size/mtime lines", async () => {
  const harness = makeHarness({
    transportOptions: {
      entries: {
        "/var/log": [
          { name: "syslog", type: "file", size: 120, mtimeMs: 1_700_000_000_000, mode: 0o644 },
          { name: "nginx", type: "dir", size: 4096, mtimeMs: 1_700_000_001_000, mode: 0o755 },
          { name: "current", type: "symlink", size: 10, mtimeMs: 1_699_999_000_000, mode: 0o777 },
        ],
      },
    },
  });
  const value = await run(harness, "remote_list", { host: "prod-web-1", path: "/var/log" });
  assert.equal(value.total, 3);
  assert.deepEqual(
    value.entries.map((entry) => entry.name),
    ["current", "nginx", "syslog"],
  );
  const text = renderText(harness, "remote_list", {}, value);
  assert.match(text, /prod-web-1:\/var\/log \(3 entries\)/);
  assert.match(text, /^dir  4096  \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z  nginx$/m);
  assert.match(text, /^file  120  .*  syslog$/m);
  assert.match(text, /^symlink  10  .*  current$/m);
});

test("remote_list bounds the entry list but reports the full count", async () => {
  const listing = Array.from({ length: 2005 }, (_, index) => ({
    name: `f${String(index).padStart(4, "0")}`,
    type: "file",
    size: index,
    mtimeMs: 1_700_000_000_000,
    mode: 0o644,
  }));
  const harness = makeHarness({ transportOptions: { entries: { "/data": listing } } });
  const value = await run(harness, "remote_list", { host: "prod-web-1", path: "/data" });
  assert.equal(value.total, 2005);
  assert.equal(value.entries.length, 2000);
  const text = renderText(harness, "remote_list", {}, value);
  assert.match(text, /\(2005 entries\)/);
  assert.match(text, /\[truncated; showing first 2000 of 2005 entries\]/);
});

// ---------------------------------------------------------------------------
// remote_write
// ---------------------------------------------------------------------------

test("remote_write asks approval before creating a file and reports bytes", async () => {
  const harness = makeHarness();
  const value = await run(harness, "remote_write", {
    host: "prod-web-1",
    path: "~/notes.txt",
    content: "hello\nworld\n",
  });
  assert.equal(value.path, "/home/ops/notes.txt");
  assert.equal(value.created, true);
  assert.equal(value.bytesWritten, 12);
  assert.equal(harness.approval.calls.length, 1);
  assert.equal(harness.approval.calls[0].toolName, "remote_write");
  assert.equal(harness.approval.calls[0].action, "write");
  assert.equal(harness.approval.calls[0].subject, "/home/ops/notes.txt");
  assert.equal(harness.approval.calls[0].mutating, true);

  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.path, "/home/ops/notes.txt");
  assert.equal(writeCall.content.toString("utf8"), "hello\nworld\n");
  assert.equal(writeCall.options.createDirs, false);
  assert.equal(writeCall.options.signal, harness.exec.signal);
  assert.equal(writeCall.options.mode, undefined);

  const text = renderText(harness, "remote_write", {}, value);
  assert.equal(text, "Wrote 12 bytes to prod-web-1:/home/ops/notes.txt (created).");
});

test("remote_write preserves the mode of an existing file and honors create_dirs", async () => {
  const harness = makeHarness({
    transportOptions: { files: { "/etc/app.conf": { content: "old", mode: 0o600 } } },
  });
  const value = await run(harness, "remote_write", {
    host: "prod-web-1",
    path: "/etc/app.conf",
    content: "new",
    create_dirs: true,
  });
  assert.equal(value.created, false);
  assert.equal(value.mode, 0o600);
  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.options.createDirs, true);
  assert.equal(writeCall.options.mode, 0o600);
  const chmodCall = harness.transport.calls.find((call) => call.method === "chmod");
  assert.equal(chmodCall.mode, 0o600);
  const text = renderText(harness, "remote_write", {}, value);
  assert.match(text, /\(replaced, mode 0o600\)/);
});

test("remote_write is denied on read-only hosts and under policy never without writing", async () => {
  const readonly = makeHarness({
    hostRecords: DEFAULT_HOST_RECORDS.map((record) =>
      record.name === "prod-web-1" ? { ...record, readonly: true } : record,
    ),
  });
  await assert.rejects(
    run(readonly, "remote_write", { host: "prod-web-1", path: "/tmp/x", content: "x" }),
    /configured read-only/,
  );
  assert.equal(
    readonly.transport.calls.some((call) => call.method === "writeFile"),
    false,
  );

  const never = makeHarness({ approvalOptions: { policy: "never" } });
  await assert.rejects(
    run(never, "remote_write", { host: "prod-web-1", path: "/tmp/x", content: "x" }),
    /policy is "never"/,
  );
  assert.equal(
    never.transport.calls.some((call) => call.method === "writeFile"),
    false,
  );
});

// ---------------------------------------------------------------------------
// remote_edit
// ---------------------------------------------------------------------------

test("remote_edit replaces one occurrence after reading, preserving mode", async () => {
  const harness = makeHarness({
    transportOptions: { files: { "/etc/app.conf": { content: "mode = fast\nport = 80\n", mode: 0o640 } } },
  });
  const value = await run(harness, "remote_edit", {
    host: "prod-web-1",
    path: "/etc/app.conf",
    old_string: "port = 80",
    new_string: "port = 8080",
  });
  assert.equal(value.replacements, 1);
  assert.equal(value.bytesWritten, Buffer.byteLength("mode = fast\nport = 8080\n"));

  const methodOrder = harness.transport.calls
    .filter((call) => call.method === "stat" || call.method === "readFile" || call.method === "writeFile")
    .map((call) => call.method);
  assert.deepEqual(methodOrder, ["stat", "readFile", "writeFile"]);
  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.content.toString("utf8"), "mode = fast\nport = 8080\n");
  assert.equal(writeCall.options.mode, 0o640);
  const chmodCall = harness.transport.calls.find((call) => call.method === "chmod");
  assert.equal(chmodCall.mode, 0o640);
  const text = renderText(harness, "remote_edit", {}, value);
  assert.equal(text, "Edited prod-web-1:/etc/app.conf: 1 replacement, 24 bytes written.");
});

test("remote_edit fails on zero matches before asking approval", async () => {
  const harness = makeHarness({ transportOptions: { files: { "/etc/app.conf": "mode = fast\n" } } });
  await assert.rejects(
    run(harness, "remote_edit", { host: "prod-web-1", path: "/etc/app.conf", old_string: "port = 80", new_string: "port = 8080" }),
    /old_string was not found in prod-web-1:\/etc\/app\.conf/,
  );
  assert.equal(harness.approval.calls.length, 0);
  assert.equal(
    harness.transport.calls.some((call) => call.method === "writeFile"),
    false,
  );
});

test("remote_edit fails on multiple matches unless replace_all is set", async () => {
  const harness = makeHarness({
    transportOptions: { files: { "/etc/hosts": "10.0.0.1 host\n10.0.0.2 host\n10.0.0.3 host\n" } },
  });
  await assert.rejects(
    run(harness, "remote_edit", { host: "prod-web-1", path: "/etc/hosts", old_string: "host", new_string: "node" }),
    /old_string matches 3 occurrences .* set replace_all=true/,
  );
  assert.equal(harness.approval.calls.length, 0);

  const replaced = await run(harness, "remote_edit", {
    host: "prod-web-1",
    path: "/etc/hosts",
    old_string: "host",
    new_string: "node",
    replace_all: true,
  });
  assert.equal(replaced.replacements, 3);
  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.content.toString("utf8"), "10.0.0.1 node\n10.0.0.2 node\n10.0.0.3 node\n");
});

test("remote_edit refuses an identical replacement and a missing file", async () => {
  const harness = makeHarness({ transportOptions: { files: { "/etc/a": "same\n" } } });
  await assert.rejects(
    run(harness, "remote_edit", { host: "prod-web-1", path: "/etc/a", old_string: "same", new_string: "same" }),
    /identical/,
  );
  await assert.rejects(
    run(harness, "remote_edit", { host: "prod-web-1", path: "/etc/missing", old_string: "a", new_string: "b" }),
    /Remote file not found/,
  );
});

// ---------------------------------------------------------------------------
// remote_transfer
// ---------------------------------------------------------------------------

test("remote_transfer uploads an in-workspace file and expands the remote ~", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  const localFile = join(workspace, "notes.txt");
  await writeLocal(localFile, "payload\n");
  const harness = makeHarness({ workspace });

  const value = await run(harness, "remote_transfer", {
    description: "ship notes",
    host: "prod-web-1",
    direction: "upload",
    local_path: "notes.txt",
    remote_path: "~/incoming/notes.txt",
  });
  assert.equal(value.direction, "upload");
  assert.equal(value.localPath, localFile);
  assert.equal(value.remotePath, "/home/ops/incoming/notes.txt");
  assert.equal(value.bytes, 8);
  assert.equal(harness.approval.calls.length, 1);
  assert.equal(harness.approval.calls[0].action, "transfer");
  assert.equal(harness.approval.calls[0].description, "ship notes");
  assert.equal(harness.approval.calls[0].mutating, true);

  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.path, "/home/ops/incoming/notes.txt");
  assert.equal(writeCall.content.toString("utf8"), "payload\n");
  assert.equal(writeCall.options.createDirs, false);
  const text = renderText(harness, "remote_transfer", {}, value);
  assert.match(text, /^Uploaded 8 bytes from .*notes\.txt to prod-web-1:\/home\/ops\/incoming\/notes\.txt in \d+ms\.$/);
});

test("remote_transfer refuses local paths outside the session workspace unless allowed", async (t) => {
  const { root, workspace } = await makeTempWorkspace(t);
  await writeLocal(join(root, "escape.txt"), "outside\n");

  const harness = makeHarness({ workspace });
  await assert.rejects(
    run(harness, "remote_transfer", {
      description: "escape",
      host: "prod-web-1",
      direction: "upload",
      local_path: "../escape.txt",
      remote_path: "/tmp/escape.txt",
    }),
    /outside the session workspace/,
  );
  assert.equal(harness.approval.calls.length, 0);
  assert.equal(
    harness.transport.calls.some((call) => call.method === "writeFile"),
    false,
  );

  const allowed = makeHarness({ workspace, config: { allowLocalOutsideWorkspace: true } });
  const value = await run(allowed, "remote_transfer", {
    description: "escape",
    host: "prod-web-1",
    direction: "upload",
    local_path: "../escape.txt",
    remote_path: "/tmp/escape.txt",
  });
  assert.equal(value.localPath, join(root, "escape.txt"));
  assert.equal(value.bytes, 8);
});

test("remote_transfer refuses to overwrite unless overwrite=true", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  await writeLocal(join(workspace, "notes.txt"), "new\n");
  const harness = makeHarness({
    workspace,
    transportOptions: { files: { "/home/ops/notes.txt": { content: "old\n", mode: 0o600 } } },
  });

  await assert.rejects(
    run(harness, "remote_transfer", {
      description: "ship",
      host: "prod-web-1",
      direction: "upload",
      local_path: "notes.txt",
      remote_path: "~/notes.txt",
    }),
    /Remote file already exists: prod-web-1:\/home\/ops\/notes\.txt; pass overwrite=true/,
  );
  assert.equal(harness.approval.calls.length, 0);

  const value = await run(harness, "remote_transfer", {
    description: "ship",
    host: "prod-web-1",
    direction: "upload",
    local_path: "notes.txt",
    remote_path: "~/notes.txt",
    overwrite: true,
  });
  assert.equal(value.bytes, 4);
  const writeCall = harness.transport.calls.find((call) => call.method === "writeFile");
  assert.equal(writeCall.options.mode, 0o600);
});

test("remote_transfer downloads a remote file into the workspace", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  const harness = makeHarness({
    workspace,
    transportOptions: { files: { "/var/log/app.log": "line one\nline two\n" } },
  });
  const value = await run(harness, "remote_transfer", {
    description: "fetch logs",
    host: "prod-web-1",
    direction: "download",
    local_path: "logs/app.log",
    remote_path: "/var/log/app.log",
  });
  assert.equal(value.direction, "download");
  assert.equal(value.bytes, 18);
  assert.equal(await readLocal(join(workspace, "logs", "app.log"), "utf8"), "line one\nline two\n");
  const text = renderText(harness, "remote_transfer", {}, value);
  assert.match(text, /^Downloaded 18 bytes from prod-web-1:\/var\/log\/app\.log to .*logs\/app\.log in \d+ms\.$/);
});

test("remote_transfer refuses to overwrite a local file unless overwrite=true", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  await writeLocal(join(workspace, "existing.log"), "keep me\n");
  const harness = makeHarness({ workspace, transportOptions: { files: { "/var/log/app.log": "remote\n" } } });
  await assert.rejects(
    run(harness, "remote_transfer", {
      description: "fetch logs",
      host: "prod-web-1",
      direction: "download",
      local_path: "existing.log",
      remote_path: "/var/log/app.log",
    }),
    /Local file already exists/,
  );
  assert.equal(await readLocal(join(workspace, "existing.log"), "utf8"), "keep me\n");

  await run(harness, "remote_transfer", {
    description: "fetch logs",
    host: "prod-web-1",
    direction: "download",
    local_path: "existing.log",
    remote_path: "/var/log/app.log",
    overwrite: true,
  });
  assert.equal(await readLocal(join(workspace, "existing.log"), "utf8"), "remote\n");
});

test("remote_transfer refuses files above maxTransferBytes in both directions", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  await writeLocal(join(workspace, "big.bin"), "x".repeat(64));
  const harness = makeHarness({
    workspace,
    config: { maxTransferBytes: 16 },
    transportOptions: { files: { "/var/log/big.log": "y".repeat(64) } },
  });
  await assert.rejects(
    run(harness, "remote_transfer", {
      description: "big",
      host: "prod-web-1",
      direction: "upload",
      local_path: "big.bin",
      remote_path: "/tmp/big.bin",
    }),
    /exceeds the transfer limit of 16 bytes/,
  );
  await assert.rejects(
    run(harness, "remote_transfer", {
      description: "big",
      host: "prod-web-1",
      direction: "download",
      local_path: "downloaded.log",
      remote_path: "/var/log/big.log",
    }),
    /exceeds the transfer limit of 16 bytes/,
  );
  assert.equal(
    harness.transport.calls.some((call) => call.method === "writeFile"),
    false,
  );
});

test("remote_transfer denial branches never touch either file", async (t) => {
  const { workspace } = await makeTempWorkspace(t);
  await writeLocal(join(workspace, "notes.txt"), "payload\n");
  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    const harness = makeHarness({ workspace, approvalOptions: { outcome } });
    await assert.rejects(
      run(harness, "remote_transfer", {
        description: "ship",
        host: "prod-web-1",
        direction: "upload",
        local_path: "notes.txt",
        remote_path: "/tmp/notes.txt",
      }),
      /rejected by the user|approval request was cancelled|fail closed/,
    );
    assert.equal(
      harness.transport.calls.some((call) => call.method === "writeFile"),
      false,
    );
  }
});
