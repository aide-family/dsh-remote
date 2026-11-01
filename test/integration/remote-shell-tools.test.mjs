/**
 * Tool-layer tests for the persistent remote shell surface.
 *
 * The shell manager is faked here (the real one is covered by
 * test/integration/terminal-manager.test.mjs), while the approval gate and the
 * command classifier are the real modules, so this suite pins down the safety
 * behaviour of every shell tool.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { createApprovalGate } from "../../lib/approval.js";
import { normalizeConfig } from "../../lib/config.js";
import { createShellTools } from "../../lib/terminal/tools.js";

const EXEC = { agent: { id: "agent-a" }, callId: "call-shell-1", signal: new AbortController().signal };

const HOST = { id: "config:testbox", name: "testbox", host: "10.0.0.5", port: 22, username: "ops", source: "config" };

function config(overrides = {}) {
  return normalizeConfig({ includeSshConfig: false, ...overrides });
}

/** Fake manager recording every call; `sessionHost` maps session ids to host names. */
function createFakeManager({ sessions = new Map(), behaviour = {} } = {}) {
  const calls = [];
  const sessionsById = new Map(sessions);
  const manager = {
    calls,
    async open(request) {
      calls.push(["open", request]);
      if (behaviour.openError !== undefined) throw behaviour.openError;
      const sessionId = behaviour.sessionId ?? "remote-shell-1";
      sessionsById.set(sessionId, { sessionId, agent: request.agent, host: request.host.name, name: request.name });
      return {
        sessionId,
        status: { kind: "running" },
        motd: behaviour.motd ?? "welcome",
      };
    },
    describe(agent, sessionId) {
      calls.push(["describe", { agent, sessionId }]);
      const session = sessionsById.get(sessionId);
      if (session === undefined) {
        const error = new Error(`unknown session ${sessionId}`);
        error.code = "NO_SESSION";
        throw error;
      }
      if (session.agent !== agent) {
        const error = new Error("session belongs to another agent");
        error.code = "FOREIGN_SESSION";
        throw error;
      }
      return { sessionId, host: session.host, status: { kind: "running" } };
    },
    async send(request) {
      calls.push(["send", request]);
      if (behaviour.sendError !== undefined) throw behaviour.sendError;
      return behaviour.sendResult ?? {
        viewport: "hello from pty\r\n",
        waitReason: "inferred_idle",
        sessionStatus: { kind: "running" },
        truncated: false,
      };
    },
    read(request) {
      calls.push(["read", request]);
      return behaviour.readResult ?? {
        text: "line one\nline two",
        totalLines: 2,
        lineBegin: 0,
        lineEnd: 2,
        truncated: false,
      };
    },
    async signal(request) {
      calls.push(["signal", request]);
      if (behaviour.signalError !== undefined) throw behaviour.signalError;
      return { delivered: true, targetPgid: 0 };
    },
    async close(request) {
      calls.push(["close", request]);
      sessionsById.delete(request.sessionId);
      return true;
    },
    list(agent) {
      calls.push(["list", { agent }]);
      return [...sessionsById.values()]
        .filter((session) => session.agent === agent)
        .map((session) => ({
          sessionId: session.sessionId,
          host: session.host,
          name: session.name,
          status: { kind: "running" },
        }));
    },
  };
  return manager;
}

/** Fake host store with one allowed host and one read-only host. */
function fakeHosts({ readonly = false, allowed = true } = {}) {
  return {
    async find(query) {
      if (query === HOST.name || query === HOST.id) return HOST;
      const error = new Error(`Unknown remote host ${JSON.stringify(query)}`);
      error.code = "UNKNOWN_HOST";
      throw error;
    },
    isAllowed: () => allowed,
    isReadonly: () => readonly,
  };
}

function mountTools({ config: overrides = {}, managerOptions = {}, hostOptions = {}, approvalOutcome = "allowed-once" } = {}) {
  const cfg = config(overrides);
  const approvalCalls = [];
  const ctx = {
    get(name) {
      if (name !== "approval") return undefined;
      return {
        async request(request) {
          approvalCalls.push(request);
          return approvalOutcome;
        },
      };
    },
  };
  const approval = createApprovalGate({ ctx, config: cfg });
  const manager = createFakeManager(managerOptions);
  const tools = createShellTools({
    defineTool,
    config: cfg,
    manager,
    approval,
    hosts: fakeHosts(hostOptions),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const run = (name, args, exec = EXEC) => byName.get(name).execute(args, exec);
  return { cfg, tools, byName, manager, approvalCalls, run };
}

const OPEN_SESSION = () => new Map([["remote-shell-1", { sessionId: "remote-shell-1", agent: EXEC.agent, host: HOST.name }]]);

test("registers six shell tools in protocol order", () => {
  const { tools } = mountTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["remote_shell_open", "remote_shell_send", "remote_shell_read", "remote_shell_signal", "remote_shell_close", "remote_shell_list"],
  );
});

test("remote_shell_open opens a session without approval under auto policy", async () => {
  const { run, manager, approvalCalls } = mountTools();
  const value = await run("remote_shell_open", { host: "testbox" });
  assert.equal(value.sessionId, "remote-shell-1");
  assert.equal(value.host, "testbox");
  assert.equal(value.motd, "welcome");
  assert.equal(approvalCalls.length, 0);
  assert.equal(manager.calls.filter(([name]) => name === "open").length, 1);
});

test("remote_shell_open rejects an allowHosts-blocked host", async () => {
  const { run } = mountTools({ hostOptions: { allowed: false } });
  await assert.rejects(() => run("remote_shell_open", { host: "testbox" }), /allowHosts/);
});

test("read-only shell input runs without approval", async () => {
  const { run, approvalCalls } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  const value = await run("remote_shell_send", { sessionId: "remote-shell-1", text: "df -h" });
  assert.equal(value.waitReason, "inferred_idle");
  assert.match(value.viewport, /hello from pty/);
  assert.equal(approvalCalls.length, 0);
});

test("mutating shell input asks for approval and proceeds on allowed-once", async () => {
  const { run, approvalCalls } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  await run("remote_shell_send", { sessionId: "remote-shell-1", text: "systemctl restart nginx" });
  assert.equal(approvalCalls.length, 1);
  assert.match(approvalCalls[0].reason, /testbox/);
  assert.match(approvalCalls[0].reason, /systemctl restart nginx/);
});

test("mutating shell input is denied when approval rejects or is unavailable", async () => {
  for (const approvalOutcome of ["rejected", "unavailable"]) {
    const { run } = mountTools({ managerOptions: { sessions: OPEN_SESSION() }, approvalOutcome });
    await assert.rejects(
      () => run("remote_shell_send", { sessionId: "remote-shell-1", text: "rm -rf /tmp/x" }),
      /denied|rejected|fail closed/i,
    );
  }
});

test("policy never denies mutating shell input but allows read-only input", async () => {
  const { run, approvalCalls } = mountTools({
    config: { policy: "never" },
    managerOptions: { sessions: OPEN_SESSION() },
  });
  await run("remote_shell_send", { sessionId: "remote-shell-1", text: "ls -la" });
  await assert.rejects(
    () => run("remote_shell_send", { sessionId: "remote-shell-1", text: "mv a b" }),
    /policy is "never"/,
  );
  assert.equal(approvalCalls.length, 0);
});

test("read-only hosts deny mutating shell input", async () => {
  const { run, approvalCalls } = mountTools({
    managerOptions: { sessions: OPEN_SESSION() },
    hostOptions: { readonly: true },
  });
  await assert.rejects(
    () => run("remote_shell_send", { sessionId: "remote-shell-1", text: "chmod 777 f" }),
    /read-only/,
  );
  assert.equal(approvalCalls.length, 0);
});

test("denyCommandPatterns blocks shell input before approval", async () => {
  const { run, approvalCalls } = mountTools({
    config: { denyCommandPatterns: ["delete-everything"] },
    managerOptions: { sessions: OPEN_SESSION() },
  });
  await assert.rejects(
    () => run("remote_shell_send", { sessionId: "remote-shell-1", text: "delete-everything now" }),
    /denied/i,
  );
  assert.equal(approvalCalls.length, 0);
});

test("raw input (submit false) is not classified and never asks", async () => {
  const { run, approvalCalls } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  await run("remote_shell_send", { sessionId: "remote-shell-1", text: "\u0003", submit: false });
  assert.equal(approvalCalls.length, 0);
});

test("remote_shell_read pages scrollback and renders pagination", async () => {
  const { run } = mountTools({
    managerOptions: {
      sessions: OPEN_SESSION(),
      behaviour: { readResult: { text: "a\nb", totalLines: 8, lineBegin: 2, lineEnd: 4, truncated: true } },
    },
  });
  const value = await run("remote_shell_read", { sessionId: "remote-shell-1", offset: 2, count: 2 });
  assert.equal(value.totalLines, 8);
  const tool = mountTools().byName.get("remote_shell_read");
  const blocks = tool.output.render({ sessionId: "remote-shell-1" }, value);
  assert.match(blocks[0].text, /lines 2-3 of 8 \(truncated\)/);
  assert.match(blocks[0].text, /a\nb/);
});

test("remote_shell_signal requires approval and reports delivery", async () => {
  const { run, approvalCalls } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  const value = await run("remote_shell_signal", { sessionId: "remote-shell-1", signal: "SIGINT" });
  assert.deepEqual(value, { kind: "signal", sessionId: "remote-shell-1", signal: "SIGINT", delivered: true, targetPgid: 0 });
  assert.equal(approvalCalls.length, 1);
  assert.match(approvalCalls[0].reason, /SIGINT/);
});

test("remote_shell_signal rejects an unknown signal name", async () => {
  const { run, manager, approvalCalls } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  await assert.rejects(() => run("remote_shell_signal", { sessionId: "remote-shell-1", signal: "SIGFOO" }), /must be one of/);
  assert.equal(approvalCalls.length, 0);
  assert.equal(manager.calls.filter(([name]) => name === "signal").length, 0);
});

test("remote_shell_close and remote_shell_list use the manager owner scope", async () => {
  const { run, manager } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  const listed = await run("remote_shell_list", {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].sessionId, "remote-shell-1");
  const closed = await run("remote_shell_close", { sessionId: "remote-shell-1" });
  assert.equal(closed.closed, true);
  assert.equal((await run("remote_shell_list", {})).sessions.length, 0);
  assert.equal(manager.calls.filter(([name]) => name === "close").length, 1);
});

test("unknown and foreign sessions surface the manager error code", async () => {
  const unknown = mountTools();
  await assert.rejects(
    () => unknown.run("remote_shell_send", { sessionId: "remote-shell-999", text: "ls" }),
    (error) => error.code === "NO_SESSION",
  );
  const foreign = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  const other = { ...EXEC, agent: { id: "agent-b" } };
  await assert.rejects(
    () => foreign.run("remote_shell_send", { sessionId: "remote-shell-1", text: "ls" }, other),
    (error) => error.code === "FOREIGN_SESSION",
  );
});

test("send render includes wait reason and session status", async () => {
  const { byName } = mountTools();
  const blocks = byName.get("remote_shell_send").output.render(
    { sessionId: "remote-shell-1" },
    {
      viewport: "output line",
      waitReason: "timeout",
      sessionStatus: { kind: "exited", exitCode: 0, signal: null },
      truncated: true,
    },
  );
  assert.match(blocks[0].text, /output line/);
  assert.match(blocks[0].text, /\[wait: timeout\]/);
  assert.match(blocks[0].text, /session exited: 0/);
  assert.match(blocks[0].text, /\[output truncated\]/);
});

test("aborted execution signals never reach the manager", async () => {
  const { run, manager } = mountTools({ managerOptions: { sessions: OPEN_SESSION() } });
  const aborted = { ...EXEC, signal: AbortSignal.abort() };
  await assert.rejects(() => run("remote_shell_send", { sessionId: "remote-shell-1", text: "ls" }, aborted));
  assert.equal(manager.calls.filter(([name]) => name === "send").length, 0);
});
