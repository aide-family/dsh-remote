#!/usr/bin/env node
/**
 * End-to-end verification against the real DSH harness.
 *
 * What this proves (none of the other suites can):
 *   1. The plugin actually loads inside a real DSH profile (bundle patch,
 *      Config schema, `@deepseek-ai/*` resolution from the profile loader).
 *   2. The model sees the eight tools and calls them through the real tool
 *      pipeline (schema validation, result rendering, approval seam).
 *   3. Read-only remote actions work end to end over a real SSH connection.
 *   4. Mutating actions fail closed in headless mode (no approval answerer).
 *
 * It runs against a local SSH server fixture and the isolated development
 * profile (scripts/dev-profile.sh), so it needs no external host or network.
 *
 *   node scripts/e2e.mjs [--keep]
 *
 * Environment:
 *   DSH_DEV_HOME     defaults to <repo>/.dsh-test
 *   DSH_TEST_PROFILE defaults to remotedev
 *   DSH_BIN          defaults to "dsh"
 *   E2E_SKIP_SYNC=1  keep the plugin already installed in the profile (used to
 *                    verify a packaged tarball install instead of a lib/ copy)
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startSshServer } from "../test/fixtures/ssh-server.mjs";

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = process.env.DSH_DEV_HOME?.trim() || join(REPO_DIR, ".dsh-test");
const PROFILE = process.env.DSH_TEST_PROFILE?.trim() || "remotedev";
const DSH_BIN = process.env.DSH_BIN?.trim() || "dsh";
const PASSWORD_ENV = "DSH_REMOTE_TEST_PASSWORD";
const KEEP = process.argv.includes("--keep");

const CHILD_ENV = { ...process.env };
// Do not leak the desktop session's profile selection into the child.
delete CHILD_ENV.DSH_PROFILE;
delete CHILD_ENV.DSH_PROFILE_DIR;
CHILD_ENV.DSH_HOME = DSH_HOME;

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function pass(message) {
  log(`  ok  ${message}`);
}

function fail(message) {
  failures.push(message);
  log(`  FAIL ${message}`);
}

/**
 * Run one command, streaming nothing but capturing output. Rejects on non-zero
 * exit with captured stdout/stderr attached.
 */
function run(command, args, { env = CHILD_ENV, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_DIR, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Run one headless DSH task and parse its newline-delimited JSON event stream. */
async function runDsh(prompt) {
  const { code, stdout, stderr } = await run(DSH_BIN, ["--profile", PROFILE, "--patch", overlayPath, "--json", prompt], {
    env: { ...CHILD_ENV, [PASSWORD_ENV]: server.password },
  });
  /** @type {any[]} */
  const events = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // stray non-JSON line; keep it visible in diagnostics
      events.push({ type: "raw", text: line });
    }
  }
  return { code, stdout, stderr, events };
}

/** @type {Awaited<ReturnType<typeof startSshServer>>} */
let server;
/** @type {string} */
let overlayPath;
/** @type {string} */
let overlayDir;

function eventDiagnostics(result) {
  const lines = result.events.map((event) => {
    if (event.type === "tool_call") return `tool_call ${event.tool} ${JSON.stringify(event.input)}`;
    if (event.type === "tool_result") return `tool_result ${event.status} ${String(event.result).slice(0, 600)}`;
    if (event.type === "final") return `final ${String(event.text).slice(0, 400)}`;
    if (event.type === "status") return `status ${event.phase}`;
    if (event.type === "raw") return `raw ${event.text.slice(0, 400)}`;
    return `${event.type}`;
  });
  return lines.join("\n");
}

function findToolCall(result, tool) {
  return result.events.find((event) => event.type === "tool_call" && event.tool === tool);
}

function findToolResult(result, callId) {
  return result.events.find((event) => event.type === "tool_result" && event.callId === callId);
}

/** Assert a result contains no harness-level failure. */
function assertRunOk(result, label) {
  if (result.code !== 0) {
    fail(`${label}: dsh exited ${result.code}\n${result.stderr}\n${eventDiagnostics(result)}`);
    return false;
  }
  const turnEnd = result.events.find((event) => event.type === "status" && event.phase === "turn_end");
  if (turnEnd?.reason?.kind !== "completed") {
    fail(`${label}: turn did not complete (${JSON.stringify(turnEnd?.reason)})`);
    return false;
  }
  return true;
}

async function main() {
  log("dsh-remote end-to-end verification");
  log(`  repo:    ${REPO_DIR}`);
  log(`  DSH_HOME: ${DSH_HOME}`);
  log(`  profile: ${PROFILE}`);

  log("\n[1/8] preparing the isolated DSH profile");
  let setup = await run("bash", [join(REPO_DIR, "scripts", "dev-profile.sh"), PROFILE], {
    env: { ...CHILD_ENV, DSH_DEV_HOME: DSH_HOME },
  });
  if (setup.code !== 0) throw new Error(`dev-profile.sh failed:\n${setup.stderr || setup.stdout}`);
  const skipSync = process.env.E2E_SKIP_SYNC === "1";
  if (!skipSync) {
    setup = await run("bash", [join(REPO_DIR, "scripts", "sync-profile.sh"), PROFILE], {
      env: { ...CHILD_ENV, DSH_DEV_HOME: DSH_HOME },
    });
    if (setup.code !== 0) throw new Error(`sync-profile.sh failed:\n${setup.stderr || setup.stdout}`);
  }
  // A fresh fixture server key each run: drop the TOFU store so the first
  // connection exercises trust-on-first-use instead of a changed-key rejection.
  await rm(join(DSH_HOME, "remote", "known-hosts.json"), { force: true });
  pass(skipSync ? "profile prepared (using the profile's installed plugin)" : "profile prepared and plugin synced");

  log("\n[2/8] starting the SSH server fixture");
  server = await startSshServer();
  await writeFile(join(server.rootDir, "e2e-note.txt"), "line-one\nline-two\nline-three\n", "utf8");
  await mkdir(join(server.rootDir, "scratch"), { recursive: true });
  pass(`fixture listening on 127.0.0.1:${server.port}`);

  overlayDir = await mkdtemp(join(tmpdir(), "dsh-remote-e2e-"));
  overlayPath = join(overlayDir, "overlay.yml");
  await writeFile(
    overlayPath,
    [
      "# generated by scripts/e2e.mjs",
      "- id: dsh-remote",
      "  config:",
      "    includeSshConfig: false",
      "    policy: ask-not-allowed-placeholder", // replaced below
      "    hosts:",
      "      - name: testbox",
      "        host: 127.0.0.1",
      `        port: ${server.port}`,
      `        username: ${server.username}`,
      `        passwordEnv: ${PASSWORD_ENV}`,
      "        description: e2e fixture server",
      "    connectTimeoutMs: 5000",
      "    execTimeoutMs: 20000",
      "",
    ].join("\n").replace("policy: ask-not-allowed-placeholder", "policy: auto"),
    "utf8",
  );

  try {
    log("\n[3/8] remote_hosts: the model must discover the fixture host");
    {
      const result = await runDsh("Call the remote_hosts tool and tell me the exact names of the available hosts. Reply with the names only.");
      if (assertRunOk(result, "remote_hosts")) {
        const call = findToolCall(result, "remote_hosts");
        if (call === undefined) {
          fail(`remote_hosts: the model did not call the tool\n${eventDiagnostics(result)}`);
        } else {
          const toolResult = findToolResult(result, call.callId);
          const text = String(toolResult?.result ?? "");
          if (toolResult?.status === "error") fail(`remote_hosts: tool error: ${text}`);
          else if (!text.includes("testbox")) fail(`remote_hosts: result does not list testbox: ${text}`);
          else pass("remote_hosts listed the configured host through the real pipeline");
        }
      }
    }

    log("\n[4/8] remote_exec (read-only): runs over the real SSH connection");
    {
      const result = await runDsh(
        "Use the remote_exec tool with host \"testbox\" to run exactly: echo e2e-ok-123. Do not use any other tool. Report the exit code and stdout.",
      );
      if (assertRunOk(result, "remote_exec read-only")) {
        const call = findToolCall(result, "remote_exec");
        if (call === undefined) {
          fail(`remote_exec: the model did not call the tool\n${eventDiagnostics(result)}`);
        } else {
          const toolResult = findToolResult(result, call.callId);
          const text = String(toolResult?.result ?? "");
          if (toolResult?.status === "error") fail(`remote_exec: tool error: ${text}`);
          else if (!text.includes("e2e-ok-123")) fail(`remote_exec: stdout missing from result: ${text}`);
          else if (!/exit code: 0/i.test(text)) fail(`remote_exec: exit code marker missing: ${text}`);
          else pass("read-only exec returned stdout + [exit code: 0]");
        }
      }
    }

    log("\n[5/8] remote_read: reads real remote file content");
    {
      const result = await runDsh(
        `Use the remote_read tool with host "testbox" and path "${join(server.rootDir, "e2e-note.txt")}" and tell me the last line of the file.`,
      );
      if (assertRunOk(result, "remote_read")) {
        const call = findToolCall(result, "remote_read");
        if (call === undefined) {
          fail(`remote_read: the model did not call the tool\n${eventDiagnostics(result)}`);
        } else {
          const toolResult = findToolResult(result, call.callId);
          const text = String(toolResult?.result ?? "");
          if (toolResult?.status === "error") fail(`remote_read: tool error: ${text}`);
          else if (!text.includes("line-three")) fail(`remote_read: file content missing: ${text}`);
          else pass("remote_read returned the real remote file with line numbers");
        }
      }
    }

    log("\n[6/8] remote_exec (mutating): must fail closed without an approval answerer");
    {
      const result = await runDsh(
        `Use the remote_exec tool with host "testbox" to run exactly: rm -rf '${join(server.rootDir, "scratch")}'. Report exactly whether it ran or was denied.`,
      );
      if (assertRunOk(result, "remote_exec mutating")) {
        const call = findToolCall(result, "remote_exec");
        if (call === undefined) {
          fail(`mutating exec: the model did not call the tool\n${eventDiagnostics(result)}`);
        } else {
          const toolResult = findToolResult(result, call.callId);
          const text = String(toolResult?.result ?? "");
          const denied = toolResult?.status === "error" && /denied|approval|fail closed/i.test(text);
          if (!denied) fail(`mutating exec was not denied (status=${toolResult?.status}): ${text}`);
          else pass("mutating exec was denied fail-closed (no answerer in headless mode)");
        }
      }
    }
    log("\n[7/8] non-mutating unproven command: runs without approval under the new policy");
    {
      const result = await runDsh(
        `Use the remote_exec tool with host "testbox" to run exactly: awk 'BEGIN{print "gray-auto-ok"}'. Do not use any other tool. Report the output and whether it was allowed.`,
      );
      if (assertRunOk(result, "gray auto-allow")) {
        const call = findToolCall(result, "remote_exec");
        if (call === undefined) {
          fail(`gray auto-allow: the model did not call the tool\n${eventDiagnostics(result)}`);
        } else {
          const toolResult = findToolResult(result, call.callId);
          const text = String(toolResult?.result ?? "");
          if (toolResult?.status === "error") fail(`gray auto-allow: tool error (should have run): ${text}`);
          else if (!text.includes("gray-auto-ok")) fail(`gray auto-allow: output missing: ${text}`);
          else pass("unproven (gray) command ran without approval and returned its output");
        }
      }
    }

    log("\n[8/8] remote_shell_*: persistent PTY session (open -> send -> close)");
    {
      const result = await runDsh(
        `Use the remote_shell_open tool with host "testbox", then remote_shell_send with the returned sessionId and text "echo shell-live-456", then remote_shell_close for that session. Do not use any other tool. Report the shell output and whether the session was closed.`,
      );
      if (assertRunOk(result, "remote shell")) {
        const openCall = findToolCall(result, "remote_shell_open");
        const sendCall = findToolCall(result, "remote_shell_send");
        const closeCall = findToolCall(result, "remote_shell_close");
        if (openCall === undefined || sendCall === undefined) {
          fail(`remote shell: the model did not open/send (open=${Boolean(openCall)} send=${Boolean(sendCall)})\n${eventDiagnostics(result)}`);
        } else {
          const openResult = findToolResult(result, openCall.callId);
          const sendResult = findToolResult(result, sendCall.callId);
          const sendText = String(sendResult?.result ?? "");
          if (openResult?.status === "error") {
            fail(`remote shell: open failed: ${String(openResult.result).slice(0, 400)}`);
          } else if (sendResult?.status === "error") {
            fail(`remote shell: send failed: ${sendText.slice(0, 400)}`);
          } else if (!sendText.includes("shell-live-456")) {
            fail(`remote shell: send output missing the echoed text: ${sendText.slice(0, 500)}`);
          } else {
            pass("remote PTY shell opened, echoed a command, and returned its live output");
          }
          if (closeCall !== undefined) {
            const closeResult = findToolResult(result, closeCall.callId);
            if (closeResult?.status !== "error") pass("remote shell session closed cleanly");
          }
        }
      }
    }
  } finally {
    log("\ncleanup");
    await server?.close();
    if (overlayDir !== undefined && !KEEP) await rm(overlayDir, { recursive: true, force: true });
    if (KEEP) notes.push(`fixture root kept at ${server?.rootDir ?? "(closed)"}`);
  }

  for (const note of notes) log(`note: ${note}`);
  if (failures.length > 0) {
    log(`\nE2E FAILED (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
    for (const failure of failures) log(`- ${failure.split("\n")[0]}`);
    process.exitCode = 1;
  } else {
    log("\nE2E PASSED");
  }
}

main().catch((error) => {
  console.error(`e2e crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
