/**
 * Tool-layer live mirror tests: remote_exec and the shell tools must publish
 * start/output/end events to the live hub with the agent's session id.
 *
 * The transport/manager are fakes that invoke the injected `onData` callback,
 * so this pins the wiring without SSH.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { createApprovalGate } from "../../lib/approval.js";
import { normalizeConfig } from "../../lib/config.js";
import { createLiveHub } from "../../lib/live.js";
import { createShellTools } from "../../lib/terminal/tools.js";
import { createTools } from "../../lib/tools.js";

const HOST = { id: "config:testbox", name: "testbox", host: "10.0.0.5", port: 22, username: "ops", source: "config" };
const AGENT = { id: "agent-1", session: { id: "session-1" } };
const EXEC = { agent: AGENT, callId: "call-1", signal: AbortSignal.timeout(10_000) };

function config(overrides = {}) {
  return normalizeConfig({ includeSshConfig: false, terminalEnabled: true, liveTerminal: true, ...overrides });
}

function fakeHosts() {
  return {
    async list() {
      return [HOST];
    },
    async find(query) {
      if (query === HOST.name || query === HOST.id) return HOST;
      throw new Error(`Unknown remote host ${JSON.stringify(query)}`);
    },
    isAllowed: () => true,
    isReadonly: () => false,
  };
}

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async exec(host, options) {
      calls.push(["exec", host.name, options.command]);
      options.onData?.({ stream: "stdout", chunk: "chunk-one\n" });
      options.onData?.({ stream: "stderr", chunk: "warn one\n" });
      options.onData?.({ stream: "stdout", chunk: "chunk-two\n" });
      return { code: 0, signal: null, stdout: "chunk-one\nchunk-two\n", stderr: "warn one\n", truncated: false, timedOut: false, durationMs: 12 };
    },
    async homeDir() {
      return "/home/ops";
    },
  };
}

function fakeManager() {
  return {
    describe(_agent, sessionId) {
      return { sessionId, host: "testbox", status: { kind: "running" } };
    },
    async open() {
      return { sessionId: "remote-shell-1", host: "testbox", status: { kind: "running" }, motd: "welcome" };
    },
    async send(request) {
      request.onData?.({ stream: "stdout", chunk: "shell-line-one\n" });
      request.onData?.({ stream: "stdout", chunk: "shell-line-two\n" });
      return { viewport: "shell-line-one\nshell-line-two\n", waitReason: "inferred_idle", sessionStatus: { kind: "running" }, truncated: false };
    },
    async signal() {
      return { delivered: true, targetPgid: 0 };
    },
    async close({ sessionId }) {
      return { sessionId, closed: true };
    },
    list() {
      return [];
    },
  };
}

function gate(configValue, approvalOutcome = "allowed-once") {
  const calls = [];
  const ctx = {
    get(name) {
      if (name !== "approval") return undefined;
      return {
        async request(request) {
          calls.push(request);
          return approvalOutcome;
        },
      };
    },
  };
  return { gate: createApprovalGate({ ctx, config: configValue }), approvalCalls: calls };
}

function remoteTools({ cfg = config(), hub } = {}) {
  const { gate: approval } = gate(cfg);
  const transport = fakeTransport();
  const tools = createTools({
    defineTool,
    config: cfg,
    transport,
    hosts: fakeHosts(),
    approval,
    cwdOf: async () => "/tmp",
    live: hub,
  });
  return { tools, transport, byName: new Map(tools.map((tool) => [tool.name, tool])) };
}

function shellTools({ cfg = config(), hub } = {}) {
  const { gate: approval } = gate(cfg);
  const manager = fakeManager();
  const tools = createShellTools({
    defineTool,
    config: cfg,
    manager,
    approval,
    hosts: fakeHosts(),
    live: hub,
  });
  return { tools, manager, byName: new Map(tools.map((tool) => [tool.name, tool])) };
}

test("remote_exec streams its command to the live hub with the session id", async () => {
  const hub = createLiveHub();
  const { byName } = remoteTools({ hub });
  const result = await byName.get("remote_exec").execute({ description: "echo live", host: "testbox", command: "echo live" }, EXEC);
  assert.equal(result.exitCode, 0);

  const snapshot = hub.snapshot();
  assert.equal(snapshot.commands.length, 1);
  const command = snapshot.commands[0];
  assert.equal(command.tool, "remote_exec");
  assert.equal(command.host, "testbox");
  assert.equal(command.command, "echo live");
  assert.equal(command.sessionId, "session-1");
  assert.equal(command.status, "done");
  assert.equal(command.code, 0);
  assert.equal(command.output, "chunk-one\nwarn one\nchunk-two\n");
  assert.equal(snapshot.commands[0].durationMs >= 0, true);
});

test("a denied remote_exec still appears in the live terminal as an error", async () => {
  const hub = createLiveHub();
  const cfg = config({ denyCommandPatterns: ["forbidden"] });
  const { byName } = remoteTools({ cfg, hub });
  await assert.rejects(() => byName.get("remote_exec").execute({ description: "denied", host: "testbox", command: "forbidden --now" }, EXEC), /denied/i);
  const snapshot = hub.snapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0].status, "error");
  assert.match(String(snapshot.commands[0].error), /denied/i);
});

test("remote_shell_send streams the shell output to the live hub", async () => {
  const hub = createLiveHub();
  const { byName } = shellTools({ hub });
  await byName.get("remote_shell_open").execute({ host: "testbox" }, EXEC);
  const result = await byName.get("remote_shell_send").execute({ sessionId: "remote-shell-1", text: "echo shell-live" }, EXEC);
  assert.equal(result.waitReason, "inferred_idle");

  const commands = hub.snapshot().commands;
  assert.equal(commands.length, 2);
  const open = commands.find((command) => command.tool === "remote_shell_open");
  assert.equal(open.kind, "shell-open");
  assert.equal(open.status, "done");
  const send = commands.find((command) => command.tool === "remote_shell_send");
  assert.equal(send.kind, "shell");
  assert.equal(send.command, "echo shell-live");
  assert.equal(send.output, "shell-line-one\nshell-line-two\n[inferred_idle]\n");
  assert.equal(send.sessionId, "session-1");
  assert.equal(send.status, "done");
});

test("tools work with no live hub and publish nothing", async () => {
  const { byName } = remoteTools({});
  const result = await byName.get("remote_exec").execute({ description: "echo quiet", host: "testbox", command: "echo quiet" }, EXEC);
  assert.equal(result.exitCode, 0);
  const { byName: shellByName } = shellTools({});
  await shellByName.get("remote_shell_open").execute({ host: "testbox" }, EXEC);
  await shellByName.get("remote_shell_send").execute({ sessionId: "remote-shell-1", text: "echo quiet" }, EXEC);
});

test("a throwing hub cannot break the tool call", async () => {
  const hub = {
    begin() {
      throw new Error("hub exploded");
    },
  };
  const { byName } = remoteTools({ hub });
  const result = await byName.get("remote_exec").execute({ description: "echo safe", host: "testbox", command: "echo safe" }, EXEC);
  assert.equal(result.exitCode, 0);
  const { byName: shellByName } = shellTools({ hub });
  const opened = await shellByName.get("remote_shell_open").execute({ host: "testbox" }, EXEC);
  assert.equal(opened.sessionId, "remote-shell-1");
});
