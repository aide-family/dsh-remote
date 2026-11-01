/**
 * Host-side management API tests.
 *
 * The handler is exercised through a real `node:http` server (so request
 * parsing, headers, and the fence path are real), with faked services for the
 * browser-trust connection, hosts, transport, shell manager, and the real
 * audit ring.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
};

function createFakes({ allowHosts = [] } = {}) {
  const transportCalls = [];
  const managerCalls = [];
  const sessions = [
    { sessionId: "remote-shell-1", host: "testbox", status: { kind: "running" }, createdAt: 1_700_000_000_000 },
  ];
  const hosts = {
    async list() {
      return [HOST];
    },
    async find(query) {
      if (query === HOST.name || query === HOST.id) return HOST;
      const error = new Error(`Unknown remote host ${JSON.stringify(query)}`);
      error.code = "UNKNOWN_HOST";
      throw error;
    },
    isAllowed: () => true,
    isReadonly: () => false,
  };
  const transport = {
    async test(host, options) {
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
  const audit = createAuditLog({ limit: 20 });
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
  return { ctx, config, hosts, transport, manager, audit, transportCalls, managerCalls };
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
    assert.equal(result.version, "0.3.0");
    assert.equal(result.policy, "auto");
    assert.equal(result.hosts.length, 1);
    assert.equal(result.hosts[0].name, "testbox");
    assert.equal(result.hosts[0].target, "ops@10.0.0.5");
    assert.equal(result.hosts[0].port, 22);
    assert.equal(result.hosts[0].readonly, false);
    assert.equal(result.hosts[0].allowed, true);
    // authHint follows the ambient environment (an agent socket may be set).
    assert.match(result.hosts[0].authHint, /ssh-agent|default keys/);
    assert.deepEqual(result.sessions, [
      { sessionId: "remote-shell-1", host: "testbox", name: null, status: { kind: "running" }, createdAt: 1_700_000_000_000 },
    ]);
    assert.equal(result.audit.length, 1);
    assert.equal(result.audit[0].tool, "remote_exec");
    assert.deepEqual(result.counts, { hosts: 1, sessions: 1, audit: 1 });
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
