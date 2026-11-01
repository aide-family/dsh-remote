/**
 * Plugin-level integration test: real `apply()` wiring, real SSH transport, real
 * host/config/approval/tools modules, and a real SSH server fixture on
 * 127.0.0.1. Only DSH's runtime services are faked (tools registry, system
 * prompt, approval seam, effect).
 *
 * This is the test that proves the five modules actually compose: config
 * parsing, host discovery, ssh2 auth/exec/SFTP, command risk review, approval
 * gating, and result rendering all run for real.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../../lib/index.js";
import { startSshServer } from "../fixtures/ssh-server.mjs";

const PASSWORD_ENV = "DSH_REMOTE_TEST_PASSWORD";

/**
 * Minimal stand-in for the DSH services `apply()` touches.
 *
 * @param {object} [options]
 * @param {string | null} [options.approvalOutcome] Outcome returned by the approval seam; `null` = no seam mounted.
 */
function createFakeContext({ approvalOutcome = "allowed-once", cwd } = {}) {
  /** @type {any[]} */
  const tools = [];
  /** @type {any[]} */
  const sections = [];
  /** @type {(() => void)[]} */
  const effects = [];
  /** @type {any[]} */
  const approvalCalls = [];
  /** @type {string[]} */
  const warnings = [];

  /** Recorded management-API route registrations (config.managementApi). */
  const routes = [];
  const ctx = {
    /**
     * Minimal `ctx.inject` stand-in: runs the callback immediately with a scope
     * whose `webServer.register` records the route and returns a disposer.
     */
    inject(deps, callback) {
      assert.deepEqual(deps, ["webServer"]);
      const disposers = [];
      const scope = {
        effect(run, label) {
          assert.equal(typeof label, "string");
          const disposer = run();
          if (typeof disposer === "function") disposers.push(disposer);
          return () => {};
        },
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      };
      const disposer = callback(scope);
      return typeof disposer === "function" ? disposer : () => {};
    },
    tools: {
      register(tool) {
        tools.push(tool);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    effect(run, label) {
      assert.equal(typeof run, "function");
      assert.equal(typeof label, "string");
      effects.push(run);
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
    get(name) {
      if (name === "workingDirectory") {
        return {
          async ensure() {
            if (cwd === undefined) throw new Error("no cwd");
            return cwd;
          },
        };
      }
      if (name !== "approval") return undefined;
      if (approvalOutcome === null) return undefined;
      return {
        async request(request) {
          approvalCalls.push(request);
          return approvalOutcome;
        },
      };
    },
  };

  return { ctx, tools, sections, effects, approvalCalls, warnings, routes };
}

/**
 * Stable Agent identity, as DSH passes the same live Agent object to every tool
 * call of one session (the shell manager fences sessions by exact identity).
 */
const AGENT = { id: "test-agent" };

/** Execute one registered tool the way the DSH registry would. */
async function runTool(tools, name, args, signal = AbortSignal.timeout(30_000)) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `tool ${name} is not registered`);
  return tool.execute(args, { agent: AGENT, callId: `call-${name}`, signal });
}

/** @type {Awaited<ReturnType<typeof startSshServer>>} */
let server;
let workspace;
let previousDshHome;
let previousPassword;
let testDshHome;

test.before(async () => {
  server = await startSshServer();
  workspace = await mkdtemp(join(tmpdir(), "dsh-remote-plugin-ws-"));
  previousDshHome = process.env.DSH_HOME;
  previousPassword = process.env[PASSWORD_ENV];
  testDshHome = await mkdtemp(join(tmpdir(), "dsh-remote-plugin-home-"));
  process.env.DSH_HOME = testDshHome;
  process.env[PASSWORD_ENV] = server.password;
});

test.after(async () => {
  await server?.close();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  if (previousPassword === undefined) delete process.env[PASSWORD_ENV];
  else process.env[PASSWORD_ENV] = previousPassword;
  if (testDshHome !== undefined) await rm(testDshHome, { recursive: true, force: true });
});

/** Host config pointing at the fixture server, password provided via env. */
function fixtureHost(overrides = {}) {
  return {
    name: "testbox",
    host: server.host,
    port: server.port,
    username: server.username,
    passwordEnv: PASSWORD_ENV,
    description: "fixture ssh server",
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    hosts: [fixtureHost()],
    includeSshConfig: false,
    policy: "auto",
    allowHosts: [],
    readonlyHosts: [],
    denyCommandPatterns: [],
    connectTimeoutMs: 5_000,
    execTimeoutMs: 20_000,
    maxOutputBytes: 100_000,
    maxReadBytes: 100_000,
    maxTransferBytes: 1_000_000,
    knownHostsPolicy: "tofu",
    allowLocalOutsideWorkspace: false,
    promptGuidance: true,
    managementApi: false,
    liveTerminal: false,
    ...overrides,
  };
}

/** Apply the plugin and return its registered surface. */
function mount(config, options = {}) {
  const fake = createFakeContext({ cwd: workspace, ...options });
  apply(fake.ctx, config);
  return fake;
}

test("apply registers the remote tools, shell tools and prompt sections", () => {
  const { tools, sections, effects } = mount(baseConfig());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "remote_hosts",
      "remote_probe",
      "remote_exec",
      "remote_read",
      "remote_list",
      "remote_write",
      "remote_edit",
      "remote_transfer",
      "remote_shell_open",
      "remote_shell_send",
      "remote_shell_read",
      "remote_shell_signal",
      "remote_shell_close",
      "remote_shell_list",
    ],
  );
  assert.equal(sections.length, 2);
  assert.deepEqual(
    sections.map((section) => section.name),
    ["tool:remote", "tool:remote-shell"],
  );
  for (const section of sections) {
    assert.equal(typeof section.order, "number");
    assert.equal(typeof section.text, "string");
  }
  assert.match(sections[0].text, /remote_hosts/);
  assert.match(sections[1].text, /remote_shell_send/);
  assert.ok(effects.length >= 1);
});

test("terminalEnabled=false keeps the shell surface out", () => {
  const { tools, sections } = mount(baseConfig({ terminalEnabled: false }));
  assert.equal(tools.length, 8);
  assert.equal(sections.length, 1);
});

test("management API and live stream routes register only with a web server", () => {
  const both = mount(baseConfig({ managementApi: true, liveTerminal: true }));
  assert.equal(both.routes.length, 2);
  const api = both.routes.find((route) => route.path === "/dsh-remote/api");
  const live = both.routes.find((route) => route.path === "/dsh-remote/live");
  assert.ok(api !== undefined);
  assert.equal(api.kind, "prefix");
  assert.equal(typeof api.handler, "function");
  assert.ok(live !== undefined);
  assert.equal(live.kind, "exact");
  assert.equal(typeof live.handler, "function");

  const apiOnly = mount(baseConfig({ managementApi: true, liveTerminal: false }));
  assert.equal(apiOnly.routes.length, 1);
  assert.equal(apiOnly.routes[0].path, "/dsh-remote/api");

  const liveOnly = mount(baseConfig({ managementApi: false, liveTerminal: true }));
  assert.equal(liveOnly.routes.length, 1);
  assert.equal(liveOnly.routes[0].path, "/dsh-remote/live");

  const off = mount(baseConfig({ managementApi: false, liveTerminal: false }));
  assert.equal(off.routes.length, 0);
});

test("remote_hosts discovers the configured fixture host", async () => {
  const { tools } = mount(baseConfig());
  const value = await runTool(tools, "remote_hosts", {});
  assert.equal(value.total, 1);
  assert.equal(value.hosts[0].name, "testbox");
  assert.equal(value.hosts[0].host, server.host);
  assert.equal(value.hosts[0].port, server.port);
  assert.equal(value.hosts[0].readonly, false);
});

test("remote_probe connects and reports host facts", async () => {
  const { tools } = mount(baseConfig());
  const value = await runTool(tools, "remote_probe", { host: "testbox" });
  assert.equal(value.host, "testbox");
  assert.equal(value.ok, true);
  assert.equal(typeof value.latencyMs, "number");
  assert.ok(value.info !== undefined);
  assert.equal(typeof value.info.user, "string");
});

test("remote_exec runs a read-only command without approval", async () => {
  const { tools, approvalCalls } = mount(baseConfig());
  const value = await runTool(tools, "remote_exec", {
    description: "print a greeting",
    host: "testbox",
    command: "echo hello-from-fixture",
  });
  assert.equal(value.exitCode, 0);
  assert.match(value.stdout, /hello-from-fixture/);
  assert.equal(approvalCalls.length, 0);
});

test("remote_exec asks for approval on a mutating command and runs it when allowed", async () => {
  const { tools, approvalCalls } = mount(baseConfig(), { approvalOutcome: "allowed-once" });
  const target = join(server.rootDir, "to-delete");
  await mkdir(target, { recursive: true });
  const value = await runTool(tools, "remote_exec", {
    description: "remove a scratch directory",
    host: "testbox",
    command: `rm -rf '${target}'`,
  });
  assert.equal(value.exitCode, 0);
  assert.equal(approvalCalls.length, 1);
  assert.match(approvalCalls[0].reason, /testbox/);
  assert.match(approvalCalls[0].reason, /rm -rf/);
  assert.equal(approvalCalls[0].toolName, "remote_exec");
});

test("remote_exec denyCommandPatterns short-circuits before approval", async () => {
  const { tools, approvalCalls } = mount(baseConfig({ denyCommandPatterns: ["delete-everything"] }));
  await assert.rejects(
    () => runTool(tools, "remote_exec", { description: "denied command", host: "testbox", command: "delete-everything --now" }),
    /denied/i,
  );
  assert.equal(approvalCalls.length, 0);
});

test("remote_exec fails closed when the approval seam rejects or is absent", async () => {
  for (const options of [{ approvalOutcome: "rejected" }, { approvalOutcome: null }]) {
    const { tools } = mount(baseConfig(), options);
    await assert.rejects(
      () =>
        runTool(tools, "remote_exec", {
          description: "mutate the host",
          host: "testbox",
          command: `touch '${join(server.rootDir, "rejected")}'`,
        }),
      /denied|rejected|no approval answerer/i,
    );
  }
});

test("read-only hosts deny mutating actions but keep read tools working", async () => {
  const { tools, approvalCalls } = mount(baseConfig({ readonlyHosts: ["testbox"] }));
  const listed = await runTool(tools, "remote_list", { host: "testbox", path: server.rootDir });
  assert.ok(listed.entries !== undefined);
  await assert.rejects(
    () => runTool(tools, "remote_write", { host: "testbox", path: join(server.rootDir, "x.txt"), content: "nope" }),
    /read-only/i,
  );
  assert.equal(approvalCalls.length, 0);
});

test("policy never allows read-only commands and denies mutations", async () => {
  const { tools, approvalCalls } = mount(baseConfig({ policy: "never" }));
  const ok = await runTool(tools, "remote_exec", { description: "read hostname", host: "testbox", command: "hostname" });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim().length > 0, true);
  await assert.rejects(
    () => runTool(tools, "remote_exec", { description: "restart sshd", host: "testbox", command: "systemctl restart sshd" }),
    /policy is "never"/i,
  );
  assert.equal(approvalCalls.length, 0);
});

test("remote_read, remote_write, remote_edit and remote_list operate on real files", async () => {
  const { tools } = mount(baseConfig());
  const path = join(server.rootDir, "notes.txt");

  const written = await runTool(tools, "remote_write", {
    host: "testbox",
    path,
    content: "alpha\nbeta\n",
    create_dirs: true,
  });
  assert.equal(written.bytesWritten, 11);
  assert.equal(written.created, true);
  assert.equal(await readFile(path, "utf8"), "alpha\nbeta\n");

  const noted = await runTool(tools, "remote_list", { host: "testbox", path: server.rootDir });
  const entry = noted.entries.find((item) => item.name === "notes.txt");
  assert.ok(entry !== undefined);
  assert.equal(entry.type, "file");

  const read = await runTool(tools, "remote_read", { host: "testbox", path });
  assert.equal(read.lineCount, 2);
  assert.match(read.content, /alpha/);
  assert.match(read.content, /beta/);

  const edited = await runTool(tools, "remote_edit", {
    host: "testbox",
    path,
    old_string: "beta",
    new_string: "gamma",
  });
  assert.equal(edited.replacements, 1);
  assert.equal(await readFile(path, "utf8"), "alpha\ngamma\n");
});

test("remote_transfer uploads and downloads inside the session workspace", async () => {
  const { tools } = mount(baseConfig());
  const local = join(workspace, "transfer.txt");
  await writeFile(local, "payload-from-workspace", "utf8");

  const uploaded = await runTool(tools, "remote_transfer", {
    description: "upload a payload",
    host: "testbox",
    direction: "upload",
    local_path: "transfer.txt",
    remote_path: join(server.rootDir, "uploaded.txt"),
  });
  assert.equal(uploaded.bytes, 22);
  assert.equal(await readFile(join(server.rootDir, "uploaded.txt"), "utf8"), "payload-from-workspace");

  const target = join(workspace, "download.txt");
  const downloaded = await runTool(tools, "remote_transfer", {
    description: "download the payload",
    host: "testbox",
    direction: "download",
    local_path: "download.txt",
    remote_path: join(server.rootDir, "uploaded.txt"),
  });
  assert.equal(downloaded.bytes, 22);
  assert.equal(await readFile(target, "utf8"), "payload-from-workspace");
});

test("remote shell session runs over the real PTY transport", async () => {
  const { tools } = mount(baseConfig());
  const opened = await runTool(tools, "remote_shell_open", { host: "testbox" });
  try {
    assert.match(opened.sessionId, /^remote-shell-/);
    assert.equal(opened.host, "testbox");
    assert.equal(opened.status.kind, "running");
    assert.equal(typeof opened.motd, "string");

    const sent = await runTool(tools, "remote_shell_send", {
      sessionId: opened.sessionId,
      text: "echo shell-integration-ok",
    });
    assert.equal(sent.waitReason === "inferred_idle" || sent.waitReason === "timeout", true);
    assert.match(sent.viewport, /shell-integration-ok/);

    const page = await runTool(tools, "remote_shell_read", { sessionId: opened.sessionId, count: 50 });
    assert.match(page.text, /shell-integration-ok/);
    assert.ok(page.totalLines >= 1);

    const listed = await runTool(tools, "remote_shell_list", {});
    assert.equal(listed.sessions.some((session) => session.sessionId === opened.sessionId), true);
  } finally {
    await runTool(tools, "remote_shell_close", { sessionId: opened.sessionId });
  }
  const after = await runTool(tools, "remote_shell_list", {});
  assert.equal(after.sessions.length, 0);
});

test("unknown hosts and disallowed hosts fail with actionable errors", async () => {
  const { tools } = mount(baseConfig({ allowHosts: ["prod-*"] }));
  await assert.rejects(() => runTool(tools, "remote_exec", { description: "x", host: "missing-box", command: "ls" }), /Unknown remote host/);
  await assert.rejects(
    () => runTool(tools, "remote_exec", { description: "x", host: "testbox", command: "ls" }),
    /allowHosts/,
  );
});
