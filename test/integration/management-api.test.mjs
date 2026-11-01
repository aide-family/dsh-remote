/**
 * Host-side management API tests.
 *
 * The handler is exercised through a real `node:http` server (so request
 * parsing, headers, and the fence path are real), with faked services for the
 * browser-trust connection, hosts, transport, shell manager, managed-host
 * registry and terminal relay, plus the real audit ring.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { API_PREFIX, createManagementApi } from "../../lib/api.js";
import { createAuditLog } from "../../lib/audit.js";
import { normalizeConfig } from "../../lib/config.js";

const HOST = {
  id: "config:testbox",
  name: "testbox",
  host: "10.0.0.5",
  port: 22,
  username: "ops",
  source: "config",
  description: "fixture",
  tags: ["test"],
  identityFile: "~/.ssh/testbox",
};

/** A registry record, mirroring the lib/host-registry.js ManagedHost shape. */
const MANAGED = {
  name: "prod-web-1",
  host: "10.0.0.11",
  port: 22,
  username: "deploy",
  identityFile: "~/.ssh/prod",
  passwordEnv: "PROD_WEB_PASSWORD",
  proxyJump: ["bastion"],
  tags: ["prod", "web"],
  description: "primary web",
  managed: true,
  createdAt: 1_730_000_000_000,
  updatedAt: 1_730_000_000_000,
};

/** @param {unknown} error @returns {any} */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * In-memory stand-in for `createHostRegistry()`: same error codes and
 * full-replace update semantics (the host form prefills editable fields).
 *
 * @param {object[]} [initial]
 */
function createRegistry(initial = []) {
  /** @type {Map<string, any>} lowercase name -> record */
  const records = new Map();
  const calls = [];
  let tick = 1_730_000_000_000;

  function normalize(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw codedError("HOST_INVALID", "host: input must be an object");
    }
    for (const forbidden of ["password", "passphrase", "secret", "token"]) {
      if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
        throw codedError(
          "HOST_INVALID",
          `host: ${forbidden} values are never stored; reference an environment-variable NAME instead`,
        );
      }
    }
    if (typeof input.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(input.name)) {
      throw codedError("HOST_INVALID", "host: name is invalid");
    }
    if (typeof input.host !== "string" || input.host.trim() === "" || /\s/u.test(input.host)) {
      throw codedError("HOST_INVALID", "host: host is required and may not contain whitespace");
    }
    const port = input.port ?? 22;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw codedError("HOST_INVALID", "host: port must be an integer between 1 and 65535");
    }
    tick += 1_000;
    return {
      name: input.name.trim(),
      host: input.host.trim(),
      port,
      username: input.username,
      identityFile: input.identityFile,
      passwordEnv: input.passwordEnv,
      passphraseEnv: input.passphraseEnv,
      proxyJump: input.proxyJump,
      tags: input.tags,
      description: input.description,
      managed: true,
      createdAt: tick,
      updatedAt: tick,
    };
  }

  for (const record of initial) records.set(record.name.toLowerCase(), { ...record });
  return {
    calls,
    async load() {
      calls.push(["load"]);
      return [...records.values()];
    },
    list() {
      return [...records.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
    get(name) {
      return records.get(String(name).toLowerCase());
    },
    async create(input) {
      calls.push(["create", input?.name]);
      const record = normalize(input);
      if (records.has(record.name.toLowerCase())) {
        throw codedError("HOST_EXISTS", `managed host ${JSON.stringify(record.name)} already exists`);
      }
      records.set(record.name.toLowerCase(), record);
      return { ...record };
    },
    async update(name, input) {
      calls.push(["update", name]);
      const current = records.get(String(name).toLowerCase());
      if (current === undefined) {
        throw codedError("HOST_NOT_FOUND", `managed host ${JSON.stringify(name)} does not exist`);
      }
      const record = normalize(input);
      const key = record.name.toLowerCase();
      const conflict = records.get(key);
      if (conflict !== undefined && conflict !== current) {
        throw codedError("HOST_EXISTS", `managed host ${JSON.stringify(record.name)} already exists`);
      }
      records.delete(String(name).toLowerCase());
      records.set(key, record);
      return { ...record };
    },
    async delete(name) {
      calls.push(["delete", name]);
      return records.delete(String(name).toLowerCase());
    },
  };
}

/**
 * In-memory stand-in for the terminal relay/facade (`lib/terminal/relay.js`).
 */
function createRelay() {
  const calls = [];
  const sessions = [
    {
      sessionKey: "conv-1::testbox",
      host: "testbox",
      target: "ops@10.0.0.5:22",
      sessionId: "conv-1",
      state: "connected",
      attached: 1,
      reconnectAttempt: 0,
      cols: 120,
      rows: 40,
      createdAt: 1_730_000_000_000,
      updatedAt: 1_730_000_001_000,
      lastError: null,
      bytesOut: 128,
      bytesIn: 64,
      attachCount: 3,
      lastAttachAt: 1_730_000_002_000,
      lastDetachAt: 1_730_000_003_000,
    },
  ];
  return {
    calls,
    socketPath: "/tmp/dsh-remote-test/terminal.sock",
    available: true,
    async start() {
      calls.push(["start"]);
      return true;
    },
    async open({ hostName, sessionId }) {
      calls.push(["open", hostName, sessionId]);
      if (hostName === "blocked") {
        throw codedError("HOST_DISALLOWED", `host ${JSON.stringify(hostName)} is not allowed by allowHosts`);
      }
      if (hostName !== "testbox" && hostName !== "prod-web-1") {
        throw codedError("UNKNOWN_HOST", `Unknown remote host ${JSON.stringify(hostName)}`);
      }
      return {
        shell: {
          command: `exec '/usr/local/bin/node' '/repo/lib/terminal/bridge.cjs' --host '${hostName}' --session 'conv-1' --socket '/tmp/dsh-remote-test/terminal.sock'`,
          sessionKey: "conv-1::testbox",
          socketPath: "/tmp/dsh-remote-test/terminal.sock",
          host: { name: hostName, target: "ops@10.0.0.5:22" },
        },
        session: sessions[0],
      };
    },
    list({ sessionId } = {}) {
      calls.push(["list", sessionId]);
      return sessionId === undefined
        ? sessions
        : sessions.filter((session) => session.sessionId === sessionId);
    },
    async close(sessionKey) {
      calls.push(["close", sessionKey]);
      return sessionKey === sessions[0].sessionKey;
    },
  };
}

function createFakes({ allowHosts = [], registry, relay, debugLogPath } = {}) {
  const transportCalls = [];
  const managerCalls = [];
  const storeCalls = { invalidate: 0, list: 0 };
  const sessions = [
    { sessionId: "remote-shell-1", host: "testbox", status: { kind: "running" }, createdAt: 1_700_000_000_000 },
  ];

  /** Merge the managed registry into the remote host list like lib/hosts.js. */
  function managedRemoteHosts() {
    if (registry === undefined) return [];
    return registry.list().map((record) => ({
      id: `managed:${record.name}`,
      name: record.name,
      host: record.host,
      port: record.port ?? 22,
      username: record.username,
      source: "managed",
      managed: true,
      identityFile: record.identityFile,
      passwordEnv: record.passwordEnv,
      passphraseEnv: record.passphraseEnv,
      proxyJump: record.proxyJump,
      tags: record.tags,
      description: record.description,
    }));
  }

  const hosts = {
    async list() {
      storeCalls.list += 1;
      return [HOST, ...managedRemoteHosts()];
    },
    async find(query) {
      const listed = [HOST, ...managedRemoteHosts()];
      const found = listed.find((host) => host.name === query || host.id === query);
      if (found !== undefined) return found;
      throw codedError("UNKNOWN_HOST", `Unknown remote host ${JSON.stringify(query)}`);
    },
    isAllowed: () => true,
    isReadonly: () => false,
    invalidate() {
      storeCalls.invalidate += 1;
    },
  };
  const transport = {
    async test(host) {
      transportCalls.push(["test", host.name]);
      return { ok: true, latencyMs: 12 };
    },
    async exec(host, options) {
      transportCalls.push(["exec", host.name, options.command]);
      return { code: 0, stdout: "Linux 6.8.0 x86_64\nbox\n", stderr: "", truncated: false, timedOut: false, durationMs: 5 };
    },
  };
  const manager = {
    adminList() {
      managerCalls.push(["adminList"]);
      return sessions;
    },
    adminGet(sessionId) {
      managerCalls.push(["adminGet", sessionId]);
      return sessions.find((session) => session.sessionId === sessionId);
    },
    adminRead({ sessionId, offset, count }) {
      managerCalls.push(["adminRead", sessionId, offset, count]);
      if (sessionId !== "remote-shell-1") {
        const error = new Error(`unknown session ${sessionId}`);
        error.code = "NO_SESSION";
        throw error;
      }
      return { sessionId, host: "testbox", text: "line one\nline two", totalLines: 2, lineBegin: 0, lineEnd: 2, truncated: false };
    },
    async adminClose({ sessionId }) {
      managerCalls.push(["adminClose", sessionId]);
      if (sessionId !== "remote-shell-1") {
        const error = new Error(`unknown session ${sessionId}`);
        error.code = "NO_SESSION";
        throw error;
      }
      return { sessionId, closed: true };
    },
  };
  const config = normalizeConfig({ includeSshConfig: false, allowHosts });
  const audit = createAuditLog({ limit: 500 });
  audit.record({ tool: "remote_exec", host: "testbox", action: "exec", risk: "low", outcome: "ok", detail: "uptime", durationMs: 5 });
  const ctx = {
    get(name) {
      if (name !== "connection") return undefined;
      return {
        requestRejection(req) {
          if (req.headers["x-deny-test"] === "1") return 403;
          return undefined;
        },
      };
    },
  };
  return {
    ctx,
    config,
    hosts,
    transport,
    manager,
    audit,
    registry,
    relay,
    debugLogPath,
    transportCalls,
    managerCalls,
    storeCalls,
  };
}

/** Start a real HTTP server around the handler and return its base URL. */
async function startApi(fakes, { fence = true } = {}) {
  const ctx = fence ? fakes.ctx : { get: () => undefined };
  const handler = createManagementApi({
    ctx,
    config: fakes.config,
    hosts: fakes.hosts,
    transport: fakes.transport,
    manager: fakes.manager,
    audit: fakes.audit,
    registry: fakes.registry,
    relay: fakes.relay,
    hostStore: fakes.hosts,
    debugLogPath: fakes.debugLogPath,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function call(api, method, params = {}, { headers = {}, rawBody, httpMethod = "POST" } = {}) {
  const hasBody = httpMethod !== "GET" && httpMethod !== "HEAD";
  const response = await fetch(api.url, {
    method: httpMethod,
    headers: { "content-type": "application/json", ...headers },
    ...(hasBody ? { body: rawBody === undefined ? JSON.stringify({ method, ...params }) : rawBody } : {}),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { status: response.status, payload, text };
}

test("overview returns hosts, sessions, policy and the audit trail", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const { status, payload } = await call(api, "overview");
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    const result = payload.result;
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(result.version, pkg.version);
    assert.equal(result.policy, "auto");
    assert.equal(result.hosts.length, 1);
    assert.equal(result.hosts[0].name, "testbox");
    assert.equal(result.hosts[0].target, "ops@10.0.0.5");
    assert.equal(result.hosts[0].port, 22);
    assert.equal(result.hosts[0].readonly, false);
    assert.equal(result.hosts[0].allowed, true);
    assert.equal(result.hosts[0].managed, false);
    assert.equal(result.hosts[0].identityFile, "~/.ssh/testbox");
    assert.equal(result.hosts[0].passwordEnv, null);
    assert.equal(result.hosts[0].passphraseEnv, null);
    assert.deepEqual(result.hosts[0].proxyJump, []);
    // authHint follows the ambient environment (an agent socket may be set).
    assert.match(result.hosts[0].authHint, /ssh-agent|default keys|key file/);
    assert.deepEqual(result.sessions, [
      { sessionId: "remote-shell-1", host: "testbox", name: null, status: { kind: "running" }, createdAt: 1_700_000_000_000 },
    ]);
    assert.equal(result.audit.length, 1);
    assert.equal(result.audit[0].tool, "remote_exec");
    assert.deepEqual(result.counts, { hosts: 1, sessions: 1, audit: 1 });
    // No relay in this composition: the terminal surface is enabled but offline.
    assert.deepEqual(result.terminal, {
      enabled: true,
      available: false,
      socketPath: null,
      sessions: [],
    });
  } finally {
    await api.close();
  }
});

test("overview exposes managed hosts and the live terminal surface", async () => {
  const registry = createRegistry([MANAGED]);
  const relay = createRelay();
  const fakes = createFakes({ registry, relay });
  const api = await startApi(fakes);
  try {
    const { status, payload } = await call(api, "overview");
    assert.equal(status, 200);
    const result = payload.result;
    assert.equal(result.hosts.length, 2);
    const managed = result.hosts.find((host) => host.name === "prod-web-1");
    assert.ok(managed !== undefined);
    assert.equal(managed.managed, true);
    assert.equal(managed.source, "managed");
    assert.equal(managed.target, "deploy@10.0.0.11");
    assert.equal(managed.identityFile, "~/.ssh/prod");
    assert.equal(managed.passwordEnv, "PROD_WEB_PASSWORD");
    assert.equal(managed.passphraseEnv, null);
    assert.deepEqual(managed.proxyJump, ["bastion"]);
    assert.equal(managed.description, "primary web");
    assert.deepEqual(managed.tags, ["prod", "web"]);

    assert.equal(result.terminal.enabled, true);
    assert.equal(result.terminal.available, true);
    assert.equal(result.terminal.socketPath, "/tmp/dsh-remote-test/terminal.sock");
    assert.equal(result.terminal.sessions.length, 1);
    assert.equal(result.terminal.sessions[0].sessionKey, "conv-1::testbox");
    assert.equal(result.terminal.sessions[0].state, "connected");
    assert.equal(result.terminal.sessions[0].attached, 1);
    assert.equal(result.counts.hosts, 2);
  } finally {
    await api.close();
  }
});

test("host.create / host.update / host.delete round-trip and invalidate the store", async () => {
  const registry = createRegistry();
  const fakes = createFakes({ registry });
  const api = await startApi(fakes);
  try {
    const created = await call(api, "host.create", {
      host: {
        name: "prod-web-1",
        host: "10.0.0.11",
        port: 2222,
        username: "ops",
        identityFile: "~/.ssh/prod",
        passwordEnv: "PROD_WEB_PASSWORD",
        proxyJump: ["bastion"],
        tags: ["prod"],
        description: "primary web",
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.payload.ok, true);
    const createdHost = created.payload.result.host;
    assert.equal(createdHost.name, "prod-web-1");
    assert.equal(createdHost.host, "10.0.0.11");
    assert.equal(createdHost.target, "ops@10.0.0.11:2222");
    assert.equal(createdHost.source, "managed");
    assert.equal(createdHost.managed, true);
    assert.equal(createdHost.identityFile, "~/.ssh/prod");
    assert.equal(createdHost.passwordEnv, "PROD_WEB_PASSWORD");
    assert.deepEqual(createdHost.proxyJump, ["bastion"]);
    assert.equal(createdHost.readonly, false);
    assert.equal(createdHost.allowed, true);
    assert.equal(fakes.storeCalls.invalidate, 1, "registry mutation invalidates the host store");

    const overview = await call(api, "overview");
    assert.equal(overview.payload.result.hosts.some((host) => host.name === "prod-web-1" && host.managed), true);

    const updated = await call(api, "host.update", {
      name: "prod-web-1",
      host: {
        name: "prod-web-1",
        host: "10.0.0.12",
        username: "root",
        identityFile: "~/.ssh/prod",
        description: "updated web",
      },
    });
    assert.equal(updated.status, 200);
    const updatedHost = updated.payload.result.host;
    assert.equal(updatedHost.host, "10.0.0.12");
    assert.equal(updatedHost.target, "root@10.0.0.12");
    assert.equal(updatedHost.description, "updated web");
    assert.equal(updatedHost.identityFile, "~/.ssh/prod");
    assert.equal(updatedHost.passwordEnv, null, "update is a full replace of editable fields");
    assert.equal(fakes.storeCalls.invalidate, 2);

    const removed = await call(api, "host.delete", { name: "prod-web-1" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.payload.result, { deleted: true });
    assert.equal(fakes.storeCalls.invalidate, 3);
    const listed = await call(api, "overview");
    assert.equal(listed.payload.result.hosts.some((host) => host.name === "prod-web-1"), false);

    // A second delete reports the documented missing-host code.
    const missing = await call(api, "host.delete", { name: "prod-web-1" });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error.code, "HOST_NOT_FOUND");
  } finally {
    await api.close();
  }
});

test("host methods map registry errors onto documented codes/statuses", async () => {
  const registry = createRegistry([MANAGED]);
  const fakes = createFakes({ registry });
  const api = await startApi(fakes);
  try {
    const duplicate = await call(api, "host.create", {
      host: { name: "prod-web-1", host: "10.0.0.99" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.payload.error.code, "HOST_EXISTS");

    const secret = await call(api, "host.create", {
      host: { name: "insecure", host: "10.0.0.99", password: "hunter2" },
    });
    assert.equal(secret.status, 400);
    assert.equal(secret.payload.error.code, "HOST_INVALID");
    assert.doesNotMatch(secret.text, /hunter2/, "secret values are never echoed back");

    const invalidName = await call(api, "host.create", {
      host: { name: "has space", host: "10.0.0.99" },
    });
    assert.equal(invalidName.status, 400);
    assert.equal(invalidName.payload.error.code, "HOST_INVALID");

    const noInput = await call(api, "host.create", {});
    assert.equal(noInput.status, 400);
    assert.equal(noInput.payload.error.code, "HOST_INVALID");

    const unknownUpdate = await call(api, "host.update", {
      name: "ghost",
      host: { name: "ghost", host: "10.0.0.99" },
    });
    assert.equal(unknownUpdate.status, 404);
    assert.equal(unknownUpdate.payload.error.code, "HOST_NOT_FOUND");

    // A host discovered from ~/.ssh/config exists but is not registry-managed.
    const unmanagedUpdate = await call(api, "host.update", {
      name: "testbox",
      host: { name: "testbox", host: "10.0.0.5" },
    });
    assert.equal(unmanagedUpdate.status, 400);
    assert.equal(unmanagedUpdate.payload.error.code, "HOST_NOT_MANAGED");

    const unmanagedDelete = await call(api, "host.delete", { name: "testbox" });
    assert.equal(unmanagedDelete.status, 400);
    assert.equal(unmanagedDelete.payload.error.code, "HOST_NOT_MANAGED");

    const unknownDelete = await call(api, "host.delete", { name: "ghost" });
    assert.equal(unknownDelete.status, 404);
    assert.equal(unknownDelete.payload.error.code, "HOST_NOT_FOUND");
  } finally {
    await api.close();
  }
});

test("overview.audit carries exactly the newest 20 operations", async () => {
  const fakes = createFakes();
  for (let i = 1; i <= 25; i += 1) {
    fakes.audit.record({ tool: "remote_exec", host: "testbox", action: "exec", risk: "low", outcome: "ok", detail: `cmd-${i}` });
  }
  const api = await startApi(fakes);
  try {
    const { payload } = await call(api, "overview");
    assert.equal(payload.result.audit.length, 20, "v0.5.1 caps the overview at 20 entries");
    assert.equal(payload.result.audit[0].detail, "cmd-25");
    assert.equal(payload.result.audit.at(-1).detail, "cmd-6");
    assert.equal(Object.prototype.hasOwnProperty.call(payload.result.audit[0], "detailFull"), false);
    assert.equal(payload.result.counts.audit, 26);
    // The audit modal/export still pages the whole ring through audit.list.
    const all = await call(api, "audit.list", { limit: 1_000 });
    assert.equal(all.payload.result.total, 26);
    assert.equal(all.payload.result.entries.length, 26);
  } finally {
    await api.close();
  }
});

test("audit.list full exposes the raw detail and validates the flag", async () => {
  const fakes = createFakes();
  const command = `echo first\n\tsudo -v\n${"x".repeat(400)}`;
  fakes.audit.record({ tool: "remote_exec", host: "testbox", action: "exec", risk: "high", outcome: "ok", detail: command });
  const api = await startApi(fakes);
  try {
    const lightweight = await call(api, "audit.list", { host: "testbox" });
    const pageEntry = lightweight.payload.result.entries[0];
    assert.equal(pageEntry.detail.length, 300);
    assert.equal(pageEntry.detail.includes("\n"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pageEntry, "detailFull"), false);

    const withFull = await call(api, "audit.list", { host: "testbox", full: true });
    assert.equal(withFull.payload.result.entries[0].detailFull, command);

    const invalid = await call(api, "audit.list", { full: "yes" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.payload.error.code, "AUDIT_INVALID");
  } finally {
    await api.close();
  }
});

test("terminal.trace appends bounded client diagnostics and skips the audit ring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-trace-"));
  const debugLogPath = join(dir, "nested", "terminal-debug.log");
  const fakes = createFakes({ debugLogPath });
  const api = await startApi(fakes);
  try {
    const auditSizeBefore = fakes.audit.size;
    const traced = await call(api, "terminal.trace", {
      stage: "attached",
      sessionId: "conv-1",
      detail: "attached after 1 retry",
    });
    assert.equal(traced.status, 200);
    assert.deepEqual(traced.payload.result, { ok: true });
    assert.equal(fakes.audit.size, auditSizeBefore, "trace lines are not recorded in the audit ring");

    const lines = (await readFile(debugLogPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.stage, "attached");
    assert.equal(parsed.sessionId, "conv-1");
    assert.equal(parsed.detail, "attached after 1 retry");
    assert.equal(typeof parsed.time, "number");

    await call(api, "terminal.trace", { stage: "api" });
    const optional = JSON.parse((await readFile(debugLogPath, "utf8")).trim().split("\n").at(-1));
    assert.equal(optional.sessionId, null);
    assert.equal(optional.detail, "");

    for (const bad of [
      { stage: "not a stage!" },
      { stage: "" },
      { stage: "x".repeat(65) },
      { stage: "write", detail: "x".repeat(2_001) },
    ]) {
      const response = await call(api, "terminal.trace", bad);
      assert.equal(response.status, 400);
      assert.equal(response.payload.error.code, "INVALID_ARGUMENT");
    }

    // Bounded log: appending past 256 KiB trims back to the last 64 KiB.
    const bigDetail = "y".repeat(2_000);
    for (let i = 0; i < 140; i += 1) {
      await call(api, "terminal.trace", { stage: "write", detail: bigDetail });
    }
    const stats = await stat(debugLogPath);
    assert.ok(stats.size > 0);
    assert.ok(stats.size <= 256 * 1024, `trace log stays bounded (${stats.size} bytes)`);
    const tail = JSON.parse((await readFile(debugLogPath, "utf8")).trim().split("\n").at(-1));
    assert.equal(tail.stage, "write");
    assert.equal(tail.detail.length, 2_000);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal.trace is best-effort when the trace path cannot be written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-trace-dir-"));
  const fakes = createFakes({ debugLogPath: dir });
  const api = await startApi(fakes);
  try {
    const response = await call(api, "terminal.trace", { stage: "error", detail: "boom" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload.result, { ok: true });
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit.list filters by host, paginates and validates its input", async () => {
  const fakes = createFakes();
  fakes.audit.record({ tool: "remote_exec", host: "prod-web-1", action: "exec", risk: "low", outcome: "ok", detail: "uptime", durationMs: 7 });
  fakes.audit.record({ tool: "remote_read", host: "testbox", action: "read", risk: "read", outcome: "ok", detail: "/etc/motd", durationMs: 3 });
  const api = await startApi(fakes);
  try {
    const filtered = await call(api, "audit.list", { host: "prod-web-1" });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.payload.result.host, "prod-web-1");
    assert.equal(filtered.payload.result.total, 1);
    assert.equal(filtered.payload.result.entries.length, 1);
    assert.equal(filtered.payload.result.entries[0].tool, "remote_exec");

    const all = await call(api, "audit.list", {});
    assert.equal(all.payload.result.host, null);
    assert.equal(all.payload.result.total, 3);
    assert.equal(all.payload.result.entries.length, 3);

    const page = await call(api, "audit.list", { limit: 1, offset: 1 });
    assert.equal(page.status, 200);
    assert.equal(page.payload.result.total, 3);
    assert.equal(page.payload.result.entries.length, 1);
    assert.equal(page.payload.result.entries[0].host, "prod-web-1");

    const missingHost = await call(api, "audit.list", { host: "never-connected" });
    assert.equal(missingHost.status, 200);
    assert.equal(missingHost.payload.result.total, 0);
    assert.deepEqual(missingHost.payload.result.entries, []);

    const badHost = await call(api, "audit.list", { host: 42 });
    assert.equal(badHost.status, 400);
    assert.equal(badHost.payload.error.code, "AUDIT_INVALID");

    const badLimit = await call(api, "audit.list", { limit: -1 });
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.payload.error.code, "AUDIT_INVALID");

    const badOffset = await call(api, "audit.list", { offset: 1.5 });
    assert.equal(badOffset.status, 400);
    assert.equal(badOffset.payload.error.code, "AUDIT_INVALID");
  } finally {
    await api.close();
  }
});

test("terminal.open / terminal.list / terminal.close drive the relay", async () => {
  const relay = createRelay();
  const fakes = createFakes({ relay });
  const api = await startApi(fakes);
  try {
    const opened = await call(api, "terminal.open", { name: "testbox", sessionId: "conv-1" });
    assert.equal(opened.status, 200);
    assert.equal(typeof opened.payload.result.shell.command, "string");
    assert.match(opened.payload.result.shell.command, /^exec '.*node' '.*lib\/terminal\/bridge\.cjs'/);
    assert.match(opened.payload.result.shell.command, /--host 'testbox' --session 'conv-1'/);
    assert.match(opened.payload.result.shell.command, /--socket '\/tmp\/dsh-remote-test\/terminal\.sock'$/);
    assert.equal(opened.payload.result.shell.sessionKey, "conv-1::testbox");
    assert.equal(opened.payload.result.session.sessionKey, "conv-1::testbox");
    assert.equal(opened.payload.result.session.state, "connected");
    assert.deepEqual(
      relay.calls.filter((call) => call[0] === "open"),
      [["open", "testbox", "conv-1"]],
    );

    const listed = await call(api, "terminal.list", {});
    assert.equal(listed.status, 200);
    assert.equal(listed.payload.result.sessions.length, 1);
    // v0.5.1 counters the client polls for attach/reuse evidence.
    const listedSession = listed.payload.result.sessions[0];
    assert.equal(listedSession.host, "testbox");
    assert.equal(listedSession.attached, 1);
    assert.equal(listedSession.attachCount, 3);
    assert.equal(listedSession.bytesIn, 64);
    assert.equal(listedSession.bytesOut, 128);
    assert.equal(listedSession.lastAttachAt, 1_730_000_002_000);
    assert.equal(listedSession.lastDetachAt, 1_730_000_003_000);
    // `{sessionId: null}` / `{}` both mean "no filter" (browser harness shape).
    const noFilter = await call(api, "terminal.list", { sessionId: null });
    assert.equal(noFilter.payload.result.sessions.length, 1);
    const listedForSession = await call(api, "terminal.list", { sessionId: "other-conversation" });
    assert.deepEqual(listedForSession.payload.result.sessions, []);

    const closed = await call(api, "terminal.close", { sessionKey: "conv-1::testbox" });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.payload.result, { closed: true });

    const missing = await call(api, "terminal.close", { sessionKey: "conv-1::other" });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error.code, "TERMINAL_NOT_FOUND");

    const disallowed = await call(api, "terminal.open", { name: "blocked" });
    assert.equal(disallowed.status, 403);
    assert.equal(disallowed.payload.error.code, "HOST_DISALLOWED");

    const unknown = await call(api, "terminal.open", { name: "ghost" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.code, "HOST_NOT_FOUND");
  } finally {
    await api.close();
  }
});

test("terminal methods fail clearly when the user terminal is disabled", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    for (const [method, params] of [
      ["terminal.open", { name: "testbox" }],
      ["terminal.list", {}],
      ["terminal.close", { sessionKey: "conv-1::testbox" }],
    ]) {
      const response = await call(api, method, params);
      assert.equal(response.status, 400, `${method} should be disabled`);
      assert.equal(response.payload.error.code, "TERMINAL_DISABLED");
    }
  } finally {
    await api.close();
  }
});

test("host.test probes the host read-only and reports the connection facts", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const { status, payload } = await call(api, "host.test", { name: "testbox" });
    assert.equal(status, 200);
    assert.equal(payload.result.ok, true);
    assert.equal(payload.result.latencyMs, 12);
    assert.match(payload.result.output, /Linux/);
    assert.deepEqual(fakes.transportCalls, [
      ["test", "testbox"],
      ["exec", "testbox", "uname -srm 2>/dev/null; hostname"],
    ]);
  } finally {
    await api.close();
  }
});

test("host.test rejects unknown and allowHosts-blocked hosts", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const unknown = await call(api, "host.test", { name: "nope" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.code, "UNKNOWN_HOST");
  } finally {
    await api.close();
  }

  const blocked = createFakes({ allowHosts: ["prod-*"] });
  blocked.hosts.isAllowed = () => false;
  const blockedApi = await startApi(blocked);
  try {
    const response = await call(blockedApi, "host.test", { name: "testbox" });
    assert.equal(response.status, 403);
    assert.equal(response.payload.error.code, "HOST_NOT_ALLOWED");
  } finally {
    await blockedApi.close();
  }
});

test("session.read and session.close go through the admin manager surface", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const page = await call(api, "session.read", { sessionId: "remote-shell-1", offset: 0, count: 10 });
    assert.equal(page.status, 200);
    assert.equal(page.payload.result.text, "line one\nline two");
    assert.equal(page.payload.result.host, "testbox");

    const closed = await call(api, "session.close", { sessionId: "remote-shell-1" });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.payload.result, { sessionId: "remote-shell-1", closed: true });
    assert.deepEqual(fakes.managerCalls, [
      ["adminRead", "remote-shell-1", 0, 10],
      ["adminGet", "remote-shell-1"],
      ["adminClose", "remote-shell-1"],
    ]);

    const missing = await call(api, "session.read", { sessionId: "remote-shell-9" });
    assert.equal(missing.status, 404);
    assert.equal(missing.payload.error.code, "NO_SESSION");
  } finally {
    await api.close();
  }
});

test("session methods fail clearly when shell support is disabled", async () => {
  const fakes = createFakes();
  fakes.manager = undefined;
  const api = await startApi(fakes);
  try {
    const response = await call(api, "session.read", { sessionId: "remote-shell-1" });
    assert.equal(response.status, 409);
    assert.equal(response.payload.error.code, "METHOD_UNAVAILABLE");
  } finally {
    await api.close();
  }
});

test("audit.clear empties the ring", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const cleared = await call(api, "audit.clear");
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.payload.result, { cleared: true });
    const overview = await call(api, "overview");
    assert.equal(overview.payload.result.audit.length, 0);
  } finally {
    await api.close();
  }
});

test("protocol errors are structured and never crash the server", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes);
  try {
    const unknown = await call(api, "does.not.exist");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.code, "UNKNOWN_METHOD");

    const get = await call(api, "overview", {}, { httpMethod: "GET" });
    assert.equal(get.status, 405);

    const invalidJson = await call(api, "overview", {}, { rawBody: "{not json" });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.payload.error.code, "INVALID_JSON");

    const arrayBody = await call(api, "overview", {}, { rawBody: "[]" });
    assert.equal(arrayBody.status, 400);

    const forbidden = await call(api, "overview", {}, { headers: { "x-deny-test": "1" } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.payload.error.code, "FORBIDDEN");
  } finally {
    await api.close();
  }
});

test("a missing connection fence fails closed", async () => {
  const fakes = createFakes();
  const api = await startApi(fakes, { fence: false });
  try {
    const response = await call(api, "overview");
    assert.equal(response.status, 503);
    assert.equal(response.payload.error.code, "FENCE_UNAVAILABLE");
  } finally {
    await api.close();
  }
});
