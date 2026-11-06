#!/usr/bin/env node
/**
 * Development loop for the dsh-remote browser half.
 *
 * Boots the isolated `webtest` DSH Web profile (from ./.dsh-test), waits for
 * its authenticated URL, drives the page with headless Chrome (playwright-core +
 * the installed Google Chrome), optionally clicks a sidebar label, and writes a
 * screenshot. The server is stopped afterwards unless --keep is passed.
 *
 *   node scripts/dev-web-test.mjs [out.png] [--click "远程运维"] [--wait 3000] [--port 53991] [--keep]
 *   node scripts/dev-web-test.mjs docs/assets/remote-terminal.png --emit-live
 *
 * `--emit-live` verifies the v0.4 right-sidebar "Remote Terminal" panel end to
 * end: it expands the right Sidebar to read the guide entry, collapses it again,
 * POSTs `/dsh-remote/api` `{method:"live.emit",…}` three times through the page
 * (so the same-origin browser cookie is used), waits for the streamed output,
 * asserts the panel auto-opened with the command text, and then screenshots it.
 *
 * Prints the page body text and every browser console warning/error so a broken
 * client bundle is diagnosable without a manual browser. Browser console errors,
 * page errors, failed HTTP responses, and failed assertions exit non-zero.
 */
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { startSshServer } from "../test/fixtures/ssh-server.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = join(REPO, ".dsh-test");
const PROFILE = process.env.DEV_WEB_PROFILE || "webtest";

/** Three injector calls: two hosts, streamed lines, scrollable terminal. */
const LIVE_EMITS = [
  {
    method: "live.emit",
    command: "echo dev-live",
    host: "testbox",
    kind: "exec",
    lines: ["dev-live-output-1", "dev-live-output-2"],
  },
  {
    method: "live.emit",
    command: "uname -srm",
    host: "testbox",
    kind: "exec",
    lines: ["Linux 6.8.0-testbox arm64", "dev-live-output-3"],
  },
  {
    method: "live.emit",
    command: "df -h /",
    host: "opsbox",
    kind: "exec",
    lines: ["/dev/vda1  40G  12G  26G  32% /"],
  },
];

/**
 * A command attributed to another session: the session-scoped panel must not
 * render it (the body receives its own sessionId prop from the slot framework).
 */
const FOREIGN_EMIT = {
  method: "live.emit",
  command: "echo foreign-session",
  host: "testbox",
  kind: "exec",
  lines: ["foreign-output-should-not-render"],
  sessionId: "session-foreign-dev",
};

/**
 * Concurrent emits that overflow the terminal pane, so the post-screenshot
 * checks can prove internal scrolling, bottom-following, and "stay put while
 * scrolled up". Sent in parallel because each emitted line sleeps on the Host.
 */
const STRESS_EMITS = Array.from({ length: 4 }, (_, index) => ({
  method: "live.emit",
  command: `seq 1 15 # stress-${index + 1}`,
  host: "stressbox",
  kind: "exec",
  lines: Array.from({ length: 15 }, (_value, line) => `stress-line-${index + 1}-${line + 1}`),
}));

const args = process.argv.slice(2);
let out = join(REPO, ".cache", "shots", "web.png");
const clicks = [];
let waitMs = 3000;
let port = 53991;
let keep = false;
let emitLive = false;
let remoteTerminal = false;
let docsShots = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--click") clicks.push(args[++i]);
  else if (arg === "--clicks") clicks.push(...String(args[++i]).split(",").map((value) => value.trim()).filter(Boolean));
  else if (arg === "--wait") waitMs = Number(args[++i]);
  else if (arg === "--port") port = Number(args[++i]);
  else if (arg === "--keep") keep = true;
  else if (arg === "--emit-live") emitLive = true;
  else if (arg === "--remote-terminal") remoteTerminal = true;
  else if (arg === "--docs-shots") docsShots = true;
  else if (!arg.startsWith("--")) out = arg;
}
const explicitPng = process.argv.slice(2).some((value) => !value.startsWith("--") && value.endsWith(".png"));
if (remoteTerminal && !explicitPng) {
  out = join(REPO, "docs", "assets", "management-page.png");
}
if (docsShots && !remoteTerminal && !explicitPng) {
  out = join(REPO, ".cache", "shots", "docs-initial.png");
}
const TERMINAL_SHOT = join(REPO, "docs", "assets", "remote-terminal.png");

/** Console messages / page errors / HTTP failures that must fail the run. */
function isBrowserError(line) {
  return (
    line.startsWith("[console.error]") ||
    line.startsWith("[pageerror]") ||
    line.startsWith("[http ")
  );
}

/** POST one management API method from inside the page (same-origin cookie). */
async function callApiFromPage(page, body) {
  return page.evaluate(async function evaluateApi(input) {
    const response = await fetch("/dsh-remote/api", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  }, body);
}

/**
 * Drive the live terminal verification: guide entry, auto-open, streamed text.
 * @returns {Promise<string[]>} failures (empty when the panel behaved)
 */
async function verifyLiveTerminal(page) {
  const failures = [];

  // 1. Expand the right Sidebar so the guide page and its entries are mounted,
  //    and prove the plugin contributed its guide entry.
  const expand = page.locator("[data-sidebar-right-expand]").first();
  if ((await expand.count()) > 0) {
    await expand.click({ force: true });
    await page.waitForTimeout(1200);
  } else {
    failures.push("no right-sidebar expand control found on the page");
  }
  const guideText = await page.locator("body").innerText();
  if (!guideText.includes("远程终端")) {
    failures.push('guide entry "远程终端" is missing from the right-sidebar guide page');
  }
  const guide = await page.evaluate(function readGuideEntries() {
    const entries = Array.from(document.querySelectorAll("[data-sidebar-right-guide-entry]"));
    return {
      kinds: entries.map((entry) => entry.getAttribute("data-sidebar-right-guide-entry")),
      texts: entries.map((entry) => entry.textContent),
    };
  });
  console.log(`live: guide entries ${JSON.stringify(guide.texts)}`);
  if (!guide.kinds.includes("dsh-remote-live")) {
    failures.push('the right-sidebar guide has no "dsh-remote-live" entry registration');
  }

  // 2. Remember the on-screen session so the emitted commands belong to it.
  const sessionId = await page.evaluate(function readSession() {
    const owner = document.querySelector("[data-sidebar-right-session]");
    return owner === null ? null : owner.getAttribute("data-sidebar-right-session");
  });
  console.log(`live: on-screen session ${sessionId === null ? "(none)" : sessionId}`);

  // 3. Collapse again, so the auto-open is observable rather than assumed.
  const toggle = page.locator("[data-sidebar-right-toggle]").first();
  if ((await toggle.count()) > 0) {
    await toggle.click({ force: true });
    await page.waitForTimeout(900);
  }
  const collapsed = await page.evaluate(function readCollapsed() {
    const panel = document.querySelector("[data-sidebar-right-panel]");
    return panel !== null && panel.getAttribute("data-sidebar-right-open") === null;
  });
  if (!collapsed) failures.push("the right Sidebar did not collapse before the live emit");

  // 4. The Host overview must advertise the live flags the panel relies on.
  const overview = await callApiFromPage(page, { method: "overview" });
  const liveFlags = overview.payload?.result?.live ?? null;
  console.log(`live: overview flags ${JSON.stringify(liveFlags)}`);
  if (overview.status !== 200 || overview.payload?.ok !== true) {
    failures.push(`overview failed: HTTP ${overview.status} ${JSON.stringify(overview.payload)}`);
  } else if (liveFlags === null || liveFlags.enabled !== true || liveFlags.autoOpen !== true) {
    failures.push("overview did not report live.enabled/live.autoOpen (profile config devLiveEvents/live flags)");
  }

  // 5. Emit the dev live commands; the first `start` should open the tab. The
  //    last event belongs to another session and must stay out of this panel.
  for (const payload of [...LIVE_EMITS, FOREIGN_EMIT]) {
    const body = { ...payload };
    if (!("sessionId" in body) && sessionId !== null) body.sessionId = sessionId;
    const emitted = await callApiFromPage(page, body);
    if (emitted.status !== 200 || emitted.payload?.ok !== true) {
      failures.push(
        `live.emit failed for ${payload.command}: HTTP ${emitted.status} ${JSON.stringify(emitted.payload)}`,
      );
    }
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(2500);

  // 6. Assert the panel auto-opened and rendered the streamed terminal text.
  const state = await page.evaluate(function readLivePanel() {
    const panel = document.querySelector("[data-sidebar-right-panel]");
    const body = document.querySelector("[data-dsh-remote-live]");
    return {
      expanded: panel !== null && panel.getAttribute("data-sidebar-right-open") !== null,
      hasPanel: body !== null,
      connection: body === null ? null : body.getAttribute("data-live-connection"),
      text: body === null ? "" : body.textContent,
      commands: body === null ? 0 : body.querySelectorAll("[data-live-command-id]").length,
    };
  });
  console.log(
    `live: panel expanded=${state.expanded} mounted=${state.hasPanel} connection=${state.connection} commands=${state.commands}`,
  );
  if (!state.expanded) failures.push("the right Sidebar did not auto-open after the first live command");
  if (!state.hasPanel) failures.push("the Remote Terminal panel body is not mounted");
  const text = await page.locator("body").innerText();
  const needles = [
    "远程终端",
    "echo dev-live",
    "dev-live-output-1",
    "dev-live-output-2",
    "dev-live-output-3",
    "uname -srm",
    "df -h /",
  ];
  for (const needle of needles) {
    if (!text.includes(needle)) failures.push(`page text is missing ${JSON.stringify(needle)}`);
  }
  if (state.text.includes("dev-live-output-1") === false) {
    failures.push("the live panel DOM does not contain the streamed output");
  }
  if (state.connection !== "已连接") {
    failures.push(`the live panel connection state is ${JSON.stringify(state.connection)}, expected 已连接`);
  }
  if (state.commands < LIVE_EMITS.length) {
    failures.push(`the live panel rendered ${state.commands} commands, expected ${LIVE_EMITS.length}`);
  }

  // 7. Session filtering: a command attributed to another session is not shown.
  if (state.text.includes("foreign-output-should-not-render") || state.text.includes("echo foreign-session")) {
    failures.push("the session-scoped panel rendered a command from another session");
  }
  if (state.commands !== LIVE_EMITS.length) {
    failures.push(
      `the live panel rendered ${state.commands} commands, expected exactly ${LIVE_EMITS.length} (foreign session filtered)`,
    );
  }

  // 8. Host filter: picking one host hides the other host's commands.
  const hostSelect = page.locator("[data-dsh-remote-live] select.dslt-select").first();
  if ((await hostSelect.count()) === 0) {
    failures.push("the live panel host filter select is missing");
  } else {
    await hostSelect.selectOption("opsbox");
    await page.waitForTimeout(400);
    const filtered = await page.evaluate(function readFilteredPanel() {
      const body = document.querySelector("[data-dsh-remote-live]");
      return body === null ? "" : body.textContent;
    });
    if (!filtered.includes("df -h /")) {
      failures.push("host filter opsbox hid its own command");
    }
    if (filtered.includes("echo dev-live")) {
      failures.push("host filter opsbox did not hide the testbox command");
    }
    await hostSelect.selectOption("");
    await page.waitForTimeout(400);
  }
  return failures;
}

/** Read the live panel's scroll geometry and jump-button visibility. */
async function readLiveLog(page) {
  return page.evaluate(function readLog() {
    const log = document.querySelector("[data-dsh-remote-live] .dslt-log");
    if (log === null) return null;
    return {
      scrollTop: log.scrollTop,
      scrollHeight: log.scrollHeight,
      clientHeight: log.clientHeight,
      jump: document.querySelector("[data-dsh-remote-live] .dslt-jump") !== null,
      commands: document.querySelectorAll("[data-dsh-remote-live] [data-live-command-id]").length,
    };
  });
}

/**
 * Scroll behavior: the pane fills the tab body and scrolls internally, new
 * output follows the bottom, scrolling up stops that, and the jump button
 * returns to the newest line. Runs after the screenshot.
 * @returns {Promise<string[]>} failures (empty when scrolling behaved)
 */
async function verifyLiveScroll(page) {
  const failures = [];
  const emitted = await page.evaluate(async function stressEmits(payloads) {
    const responses = await Promise.all(
      payloads.map(async function emit(body) {
        try {
          const response = await fetch("/dsh-remote/api", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => null);
          return { status: response.status, payload };
        } catch (error) {
          return { status: 0, payload: { error: String(error) } };
        }
      }),
    );
    return responses;
  }, STRESS_EMITS);
  for (const result of emitted) {
    if (result.status !== 200 || result.payload?.ok !== true) {
      failures.push(`stress live.emit failed: HTTP ${result.status} ${JSON.stringify(result.payload)}`);
    }
  }
  await page.waitForTimeout(1600);

  const filled = await readLiveLog(page);
  if (filled === null) {
    failures.push("the live log element disappeared during the scroll check");
    return failures;
  }
  console.log(
    `live: scroll filled scrollHeight=${filled.scrollHeight} clientHeight=${filled.clientHeight} scrollTop=${filled.scrollTop}`,
  );
  if (!(filled.scrollHeight > filled.clientHeight + 8)) {
    failures.push("the live log does not overflow: the panel does not scroll internally");
  }
  if (filled.scrollTop + filled.clientHeight < filled.scrollHeight - 8) {
    failures.push("the live log did not follow new output to the bottom");
  }

  // Real wheel input over the pane so React's scroll handler runs.
  const log = page.locator("[data-dsh-remote-live] .dslt-log").first();
  await log.hover();
  await page.mouse.wheel(0, -20_000);
  await page.waitForTimeout(500);
  const scrolledUp = await readLiveLog(page);
  console.log(
    `live: scrolled up scrollTop=${scrolledUp === null ? "?" : scrolledUp.scrollTop} jump=${scrolledUp === null ? "?" : scrolledUp.jump}`,
  );
  if (scrolledUp === null || scrolledUp.scrollTop >= filled.scrollHeight - filled.clientHeight - 8) {
    failures.push("wheel input over the live log did not scroll it up");
  }
  if (scrolledUp !== null && !scrolledUp.jump) {
    failures.push('the "回到底部" button did not appear while scrolled up');
  }

  // A new command while scrolled up must not yank the view to the bottom.
  await callApiFromPage(page, {
    method: "live.emit",
    command: "date +%T",
    host: "testbox",
    kind: "exec",
    lines: ["12:00:00"],
  });
  await page.waitForTimeout(1600);
  const afterNew = await readLiveLog(page);
  if (
    afterNew !== null &&
    scrolledUp !== null &&
    afterNew.scrollTop !== scrolledUp.scrollTop
  ) {
    failures.push("new output scrolled the pane while the user was scrolled up");
  }

  const jump = page.locator("[data-dsh-remote-live] .dslt-jump").first();
  if ((await jump.count()) === 0) {
    failures.push('the "回到底部" button is missing');
    return failures;
  }
  await jump.click({ force: true });
  await page.waitForTimeout(500);
  const returned = await readLiveLog(page);
  if (
    returned === null ||
    returned.scrollTop + returned.clientHeight < returned.scrollHeight - 8
  ) {
    failures.push('the "回到底部" button did not return to the newest line');
  }
  return failures;
}

/**
 * Local Clear: the rendered log empties (the Host hub has no `live.clear`
 * method, so this is a client-side clear), and the empty state returns.
 * Runs after the screenshot so the deliverable image keeps its terminal text.
 * @returns {Promise<string[]>} failures (empty when Clear behaved)
 */
async function verifyLiveClear(page) {
  const failures = [];
  const clearButton = page
    .locator("[data-dsh-remote-live] .dslt-btn")
    .filter({ hasText: "清空" })
    .first();
  if ((await clearButton.count()) === 0) {
    failures.push("the live panel Clear button is missing");
    return failures;
  }
  await clearButton.click({ force: true });
  await page.waitForTimeout(600);
  const state = await page.evaluate(function readClearedPanel() {
    const body = document.querySelector("[data-dsh-remote-live]");
    return {
      commands: body === null ? -1 : body.querySelectorAll("[data-live-command-id]").length,
      text: body === null ? "" : body.textContent,
    };
  });
  console.log(`live: after Clear commands=${state.commands}`);
  if (state.commands !== 0) failures.push("Clear left rendered commands behind");
  if (!state.text.includes("等待 agent 执行远端命令")) {
    failures.push("Clear did not restore the panel empty state");
  }
  return failures;
}



/** Dismiss first-run overlays (preview notes, guide masks) that cover the UI. */
async function dismissOverlays(page) {
  for (const dismissLabel of ["继续", "知道了", "开始使用", "跳过", "关闭"]) {
    const button = page.getByRole("button", { name: dismissLabel, exact: false }).first();
    try {
      if ((await button.count()) > 0 && (await button.isVisible())) {
        await button.click({ force: true });
        await page.waitForTimeout(500);
      }
    } catch {
      /* not an overlay */
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}


/**
 * Capture the documentation screenshot of the interactive terminal without the
 * quick-connect handoff (so the docs image shows the clean terminal + panel, not
 * the test profile's missing-model-key error). Reloads the page first, then
 * opens the 远程终端 panel, picks the fixture host and prints synthetic documentation output.
 */
async function captureDocsTerminalShot(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1800);
  await dismissOverlays(page);
  const expand = page.locator("[data-sidebar-right-expand]").first();
  if ((await expand.count()) > 0) {
    await expand.click({ force: true });
    await page.waitForTimeout(1000);
  }
  if ((await page.locator("[data-dsh-remote-live]").count()) === 0) {
    const guide = page.locator('[data-sidebar-right-guide-entry="dsh-remote-live"]').first();
    if ((await guide.count()) > 0) {
      await guide.click({ force: true });
      await page.waitForTimeout(1200);
    }
  }
  const picker = page.locator("[data-remote-terminal-host]").first();
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  await picker.selectOption("termbox");
  await page.locator('[data-terminal-action="open"]').first().click({ force: true });
  const terminal = page.locator("[data-sidebar-terminal]").first();
  await terminal.waitFor({ state: "visible", timeout: 25_000 });
  const ready = await waitForCondition(
    async () => (await terminal.innerText()).includes("fixture-shell-ready"),
    30_000,
  );
  if (!ready) console.warn("docs-shots: fixture shell did not become ready");
  const screen = page.locator("[data-sidebar-terminal] .xterm-screen").first();
  await screen.click({ force: true });
  await page.keyboard.type("printf 'demo-user\\nDemo OS\\n'", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await mkdir(dirname(TERMINAL_SHOT), { recursive: true });
  await page.screenshot({ path: TERMINAL_SHOT });
  console.log(`docs-shots: wrote ${TERMINAL_SHOT}`);
}

/** Poll `fn` until truthy or the timeout expires. @returns {Promise<boolean>} */
async function waitForCondition(fn, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await fn();
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * v0.5 interactive-terminal verification: quick connect from the host list opens
 * a real DSH native terminal over the relay (fixture SSH server), the user types,
 * the conversation handoff fires, the per-host audit modal lists the session,
 * and the host manager form round-trips a managed host.
 * @returns {Promise<string[]>} failures (empty when everything behaved)
 */
async function verifyRemoteTerminal(page) {
  const failures = [];
  const bodyText = () => page.locator("body").innerText();
  await dismissOverlays(page);

  // 1. Open the Remote Ops management page from the sidebar. Some compositions
  //    (e.g. dsh-better-sidebar) tuck un-pinned plugin panels into a 更多 menu.
  let entry = page.getByText("远程运维", { exact: false }).first();
  if ((await entry.count()) === 0 || !(await entry.isVisible().catch(() => false))) {
    const more = page.getByText("更多", { exact: true }).first();
    if ((await more.count()) > 0 && (await more.isVisible().catch(() => false))) {
      await more.click({ force: true });
      await page.waitForTimeout(600);
      entry = page.getByText("远程运维", { exact: false }).first();
    }
  }
  try {
    await entry.waitFor({ state: "visible", timeout: 15_000 });
    await entry.click({ force: true });
  } catch {
    failures.push("the Remote Ops sidebar entry is missing");
  }
  await page.waitForTimeout(1500);

  // 2. The fixture host row must expose the actions column.
  const connect = page.locator('[data-host-action="connect"][data-host-name="termbox"]').first();
  try {
    await connect.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    failures.push('the host actions column has no 连接 button for host "termbox"');
  }
  if (failures.length > 0) return failures;

  // 3. Quick connect: v0.5.2 creates a NEW conversation first, then opens the
  //    DSH native terminal attached to the relay in that conversation.
  const sessionBefore = await page.evaluate(function readSessionBefore() {
    const owner = document.querySelector("[data-sidebar-right-session]");
    return owner === null ? null : owner.getAttribute("data-sidebar-right-session");
  });
  await connect.click({ force: true });
  await page.waitForTimeout(2500);
  const sessionAfter = await page.evaluate(function readSessionAfter() {
    const owner = document.querySelector("[data-sidebar-right-session]");
    return owner === null ? null : owner.getAttribute("data-sidebar-right-session");
  });
  // A reused blank conversation may legitimately keep the id; what matters is
  // that the main column switched from the Remote Ops panel to a conversation.
  console.log(`remote-terminal: conversation ${sessionBefore} -> ${sessionAfter}`);
  const opsPageGone = (await page.locator('[data-host-action="connect"]').count()) === 0;
  if (!opsPageGone) {
    failures.push("quick connect did not switch the main column away from the Remote Ops page");
  }
  const composer = page.locator("textarea").first();
  if ((await composer.count()) === 0) {
    failures.push("quick connect did not reveal a conversation (no composer after connect)");
  }
  await page.waitForTimeout(3000);
  const connectDiag = await page.evaluate(function readConnectDiagnostics() {
    const notice = document.querySelector("[data-dsh-remote-notice]");
    const right = document.querySelector("[data-sidebar-right-panel]");
    return {
      notice: notice === null ? null : notice.textContent,
      noticeKind: notice === null ? null : notice.getAttribute("data-kind"),
      terminalBodies: document.querySelectorAll("[data-sidebar-terminal]").length,
      rightExpanded: right !== null && right.getAttribute("data-sidebar-right-open") !== null,
      rightText: right === null ? null : right.textContent.slice(0, 400),
    };
  });
  console.log(`remote-terminal: connect diagnostics ${JSON.stringify(connectDiag)}`);
  const terminal = page.locator("[data-sidebar-terminal]").first();
  try {
    await terminal.waitFor({ state: "visible", timeout: 25_000 });
  } catch {
    failures.push("the native DSH terminal tab did not open after 连接");
  }
  await page.waitForTimeout(1200);
  const shellReady = await waitForCondition(
    async () => (await terminal.innerText()).includes("fixture-shell-ready"),
    30_000,
  );
  if (!shellReady) failures.push("fixture-shell-ready never appeared in the native terminal");

  // 4. The user can type into it (the real PTY-over-SSH session).
  const screen = page.locator("[data-sidebar-terminal] .xterm-screen").first();
  try {
    await screen.click({ force: true });
  } catch {
    failures.push("could not focus the native terminal screen");
  }
  await page.keyboard.type("printf 'terminal-ok\\n'", { delay: 20 });
  await page.keyboard.press("Enter");
  const typed = await waitForCondition(
    async () => (await terminal.innerText()).includes("terminal-ok"),
    20_000,
  );
  if (!typed) failures.push("typing into the native terminal did not run the command");

  // v0.5.1: prove the local bridge actually attached to the relay session
  // (attached>=1, attachCount>=1, bytesIn>0 for the typed command) — this is the
  // failure the real Desktop app showed while only a local shell appeared.
  const attachedCheck = await callApiFromPage(page, { method: "terminal.list", sessionId: null });
  const attachedSessions = attachedCheck.payload?.result?.sessions ?? [];
  const attachedSession = attachedSessions.find(function findTermbox(session) {
    return session && session.host === "termbox";
  });
  if (attachedCheck.status !== 200 || attachedCheck.payload?.ok !== true) {
    failures.push(`terminal.list failed: HTTP ${attachedCheck.status} ${JSON.stringify(attachedCheck.payload)}`);
  } else if (attachedSession === undefined) {
    failures.push("terminal.list has no termbox relay session after quick connect");
  } else if (!(attachedSession.attached >= 1)) {
    failures.push(`relay session is not attached (attached=${attachedSession.attached})`);
  } else if (!(attachedSession.attachCount >= 1)) {
    failures.push(`relay session attachCount is ${attachedSession.attachCount}, expected >= 1`);
  } else if (!(attachedSession.bytesIn > 0)) {
    failures.push(`relay session bytesIn is ${attachedSession.bytesIn}, expected the typed command bytes`);
  } else {
    console.log(
      `remote-terminal: bridge attached attachCount=${attachedSession.attachCount} bytesIn=${attachedSession.bytesIn} key=${attachedSession.sessionKey}`,
    );
  }
  // 5. The terminal.open result was handed to the conversation as a user message.
  const handedOff = await waitForCondition(
    async () => (await bodyText()).includes("已连接远程主机 termbox"),
    20_000,
  );
  if (!handedOff) failures.push("quick connect did not inject the 已连接远程主机 termbox user message");
  await mkdir(dirname(TERMINAL_SHOT), { recursive: true });
  await page.screenshot({ path: TERMINAL_SHOT });
  console.log(`remote-terminal: wrote ${TERMINAL_SHOT}`);

  // Quick connect navigated the main column to the conversation; return to the
  // Remote Ops page for the audit/host-manager checks.
  const opsEntry = page.getByText("远程运维", { exact: false }).first();
  try {
    await opsEntry.waitFor({ state: "visible", timeout: 10_000 });
    await opsEntry.click({ force: true });
    await page.waitForTimeout(1200);
  } catch {
    failures.push("could not return to the Remote Ops page after quick connect");
  }

  // 6. Per-host audit modal.
  const auditButton = page.locator('[data-host-action="audit"][data-host-name="termbox"]').first();
  if ((await auditButton.count()) === 0) {
    failures.push('the host actions column has no 审计 button for host "termbox"');
  } else {
    await auditButton.click({ force: true });
    const audit = page.locator("[data-dsh-remote-audit]").first();
    try {
      await audit.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      failures.push("the per-host audit modal did not open");
    }
    const rows = await page.locator("[data-dsh-remote-audit] [data-audit-entry]").count();
    const auditText = await audit.innerText().catch(() => "");
    if (rows < 1) failures.push("the per-host audit modal has no entries (expected the terminal session event)");
    if (!/termbox|terminal|连接|打开|open/i.test(auditText)) {
      failures.push("the audit modal does not show the termbox terminal session event");
    }
    if (!/attach/i.test(auditText)) {
      failures.push("the audit modal has no terminal attach event (bridge never attached?)");
    }
    // Full-detail expansion: the row reveals the raw detailFull (<pre>).
    const expand = page.locator("[data-dsh-remote-audit] [data-audit-expand]").first();
    if ((await expand.count()) === 0) {
      failures.push("audit rows have no 详情/expand control");
    } else {
      await expand.click({ force: true });
      await page.waitForTimeout(400);
      const full = page.locator("[data-dsh-remote-audit] [data-audit-detail-full]").first();
      if ((await full.count()) === 0) {
        failures.push("expanding an audit row did not show the full detail");
      } else {
        const fullText = await full.innerText().catch(() => "");
        if (fullText.trim().length === 0) failures.push("the expanded audit detail is empty");
      }
    }
    // Export the current host's audit (JSON): a real download must start.
    const exportJson = page.locator('[data-dsh-remote-audit] [data-audit-action="export-json"]').first();
    if ((await exportJson.count()) === 0) {
      failures.push("the audit modal has no JSON export control");
    } else {
      const downloadPromise = page.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
      await exportJson.click({ force: true });
      const download = await downloadPromise;
      if (download === null) {
        failures.push("audit JSON export did not start a download");
      } else {
        const name = download.suggestedFilename();
        const path = await download.path().catch(() => null);
        if (!/\.json$/u.test(name) || path === null) {
          failures.push(`audit JSON export produced ${JSON.stringify(name)}`);
        } else {
          const exported = JSON.parse(await readFile(path, "utf8"));
          if (!Array.isArray(exported) || exported.length < 1 || typeof exported[0].detail !== "string") {
            failures.push("audit JSON export is not a non-empty entry array");
          } else if (!exported.some((entry) => typeof entry.detailFull === "string" && entry.detailFull.length > 0)) {
            failures.push("audit JSON export entries carry no detailFull");
          } else {
            console.log(`remote-terminal: audit export ${name} (${exported.length} entries, full detail present)`);
          }
        }
      }
    }
    const refresh = page.locator('[data-dsh-remote-audit] [data-audit-action="refresh"]').first();
    if ((await refresh.count()) > 0) await refresh.click({ force: true });
    const closeAudit = page.locator('[data-dsh-remote-audit] [data-audit-action="close"]').first();
    if ((await closeAudit.count()) > 0) await closeAudit.click({ force: true });
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // v0.5.1: recent operations shows exactly the newest 20 and can export all.
  const overviewNow = await callApiFromPage(page, { method: "overview" });
  const overviewAudit = overviewNow.payload?.result?.audit ?? [];
  if (overviewNow.status !== 200) {
    failures.push(`overview failed after connect: HTTP ${overviewNow.status}`);
  } else if (overviewAudit.length > 20) {
    failures.push(`overview.audit returned ${overviewAudit.length} entries, expected <= 20`);
  }
  const recentBody = await page.locator("body").innerText().catch(() => "");
  if (!recentBody.includes("最近 20 条操作")) {
    failures.push('the page does not show the "最近 20 条操作" recent-operations label');
  }

  // 7. Host manager form round-trip (add -> delete).
  const create = page.locator('[data-host-action="create"]').first();
  if ((await create.count()) === 0) {
    failures.push("the host management 添加主机 entry is missing");
  } else {
    await create.click({ force: true });
    const form = page.locator("[data-dsh-remote-host-form]").first();
    try {
      await form.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      failures.push("the add-host form did not open");
    }
    const field = (name) => page.locator(`[data-host-field="${name}"]`).first();
    await field("name").fill("uihost");
    await field("host").fill("127.0.0.1");
    if ((await field("port").count()) > 0) await field("port").fill("2222");
    if ((await field("username").count()) > 0) await field("username").fill("demo");
    const save = page.locator('[data-host-form-action="save"]').first();
    await save.click({ force: true });
    const added = await waitForCondition(
      async () => (await page.locator('[data-host-action="audit"][data-host-name="uihost"]').count()) > 0,
      10_000,
    );
    if (!added) {
      failures.push("saving the host form did not add host uihost to the table");
    } else {
      const del = page.locator('[data-host-action="delete"][data-host-name="uihost"]').first();
      if ((await del.count()) === 0) {
        failures.push("the managed host uihost has no 删除 action");
      } else {
        await del.click({ force: true });
        const confirm = page.locator('[data-dsh-remote-confirm] [data-confirm-action="ok"]').first();
        if ((await confirm.count()) > 0) await confirm.click({ force: true });
        else await page.keyboard.press("Enter");
        const removed = await waitForCondition(
          async () => (await page.locator('[data-host-action="audit"][data-host-name="uihost"]').count()) === 0,
          10_000,
        );
        if (!removed) failures.push("deleting managed host uihost did not remove it from the table");
      }
    }
  }

  // 8. Per-conversation SSH session reuse: opening the same host again must
  //    return the same relay sessionKey (one SSH PTY per conversation + host).
  const sessionId = await page.evaluate(function readOnScreenSession() {
    const owner = document.querySelector("[data-sidebar-right-session]");
    return owner === null ? null : owner.getAttribute("data-sidebar-right-session");
  });
  const openedAgain = await callApiFromPage(page, { method: "terminal.open", name: "termbox", sessionId });
  const listed = await callApiFromPage(page, { method: "terminal.list", sessionId });
  const againKey = openedAgain.payload?.result?.shell?.sessionKey ?? null;
  const listKeys = (listed.payload?.result?.sessions ?? []).map((session) => session.sessionKey);
  if (openedAgain.status !== 200 || openedAgain.payload?.ok !== true) {
    failures.push(`second terminal.open failed: ${JSON.stringify(openedAgain.payload)}`);
  } else if (listKeys.length !== 1 || listKeys[0] !== againKey || (sessionId !== null && listed.payload?.result?.sessions?.[0]?.sessionId !== sessionId)) {
    failures.push(`terminal session was not reused: open=${againKey} list=${JSON.stringify(listed.payload?.result?.sessions ?? [])}`);
  } else {
    console.log(`remote-terminal: reused session ${againKey} (conversation ${sessionId ?? "(none)"})`);
  }

  // Leave the page tidy for the docs screenshot: dismiss transient notices.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const close = page.locator("[data-dsh-remote-notice] .dshr-notice-close").first();
    if ((await close.count()) === 0) break;
    await close.click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
  }

  return failures;
}

// The interactive-terminal verification needs a real SSH server for the relay.
const terminalFixture = remoteTerminal || docsShots ? await startSshServer() : null;

// Create the isolated web profile on first use (bundle row + credentials link),
// then keep its plugin copy in sync with the working tree.
const profileDir = join(DSH_HOME, "profiles", PROFILE);
try {
  await access(join(profileDir, "package.json"));
} catch {
  execFileSync("dsh", ["--profile", PROFILE, "--from-default-profile", "web", "--dump-config"], {
    stdio: "inherit",
    env: { ...process.env, DSH_HOME },
  });
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  if (!manifest.dsh.profile.bundles.includes("@aide-family/dsh-remote")) {
    manifest.dsh.profile.bundles.push("@aide-family/dsh-remote");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const credentials = join(process.env.HOME ?? "", ".dsh", ".credentials.yaml");
  try {
    await access(credentials);
    await symlink(credentials, join(DSH_HOME, ".credentials.yaml"));
  } catch {
    /* desktop sign-in credentials are optional for the page */
  }
}
if (process.env.DEV_WEB_SKIP_SYNC !== "1") {
  execFileSync("bash", [join(REPO, "scripts", "sync-profile.sh"), PROFILE], {
    stdio: "inherit",
    env: { ...process.env, DSH_DEV_HOME: DSH_HOME },
  });
} else {
  console.log("DEV_WEB_SKIP_SYNC=1: using the profile's installed plugin copy");
}

{
  // Never discover the developer's real SSH inventory in browser captures.
  // Reset the isolated registry and replace config on every run, including
  // management-only and live-mirror checks without an SSH fixture.
  await mkdir(join(DSH_HOME, "remote"), { recursive: true });
  await rm(join(DSH_HOME, "remote", "hosts.json"), { force: true });
  await rm(join(DSH_HOME, "remote", "audit.jsonl"), { force: true });
  const patchPath = join(profileDir, "cordis.patch.yml");
  await writeFile(
    patchPath,
    [
      "- id: dsh-remote",
      '  name: "@aide-family/dsh-remote"',
      "  config:",
      "    includeSshConfig: false",
      "    devLiveEvents: true",
      "    liveTerminal: true",
      "    autoOpenLiveTerminal: true",
      "    userTerminal: true",
      ...(terminalFixture === null ? ["    hosts: []"] : [
        "    hosts:",
        "      - name: termbox",
        '        host: "127.0.0.1"',
        `        port: ${terminalFixture.port}`,
        '        username: "testuser"',
        "        passwordEnv: TERMBOX_PASSWORD",
        "        tags: [fixture]",
        '        description: interactive terminal fixture',
      ]),
      "",
    ].join("\n"),
    "utf8",
  );
  if (terminalFixture !== null) console.log(`remote-terminal: fixture ssh ${terminalFixture.host}:${terminalFixture.port}`);
}

const childEnv = { ...process.env, DSH_HOME };
delete childEnv.DSH_PROFILE;
delete childEnv.DSH_PROFILE_DIR;
if (terminalFixture !== null) childEnv.TERMBOX_PASSWORD = terminalFixture.password;

const server = spawn("dsh", ["--profile", PROFILE, "--no-open", "--port", String(port)], {
  cwd: REPO,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
let output = "";
const urlPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`web server did not print a URL:\n${output}`)), 40_000);
  const scan = () => {
    const match = output.match(/dsh web: (http:\/\/\S+)/u);
    if (match !== null) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  };
  server.stdout.on("data", (chunk) => {
    output += chunk;
    scan();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
    scan();
  });
  server.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`web server exited with ${code}:\n${output}`));
  });
});

const failures = [];
let exitCode = 0;
try {
  const url = await urlPromise;
  console.log(`web ready: ${url}`);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {
    try {
      await import("node:fs/promises").then((fs) => fs.access(candidate));
      executablePath = candidate;
      break;
    } catch {
      /* next */
    }
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const diagnostics = [];
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning" || type === "log" || type === "info") {
      diagnostics.push(`[console.${type}] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(`[pageerror] ${error.stack ?? error.message}`));
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.push(`[http ${response.status()}] ${response.url()}`);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(waitMs);
    for (const [index, label] of clicks.entries()) {
      // First-run overlays (preview notes, guide masks) can cover the sidebar.
      // Dismiss any visible one before the first click.
      if (index === 0) {
        await dismissOverlays(page);
      }
      // Prefer a real button (e.g. "测试连接" also appears inside a hint text).
      let target = page.getByRole("button", { name: label, exact: false }).first();
      if ((await target.count()) === 0) {
        target = page.getByText(label, { exact: false }).first();
      }
      await target.waitFor({ state: "visible", timeout: 15_000 });
      await target.click({ force: true });
      await page.waitForTimeout(index === 0 ? waitMs : 2500);
    }
    if (emitLive) {
      failures.push(...(await verifyLiveTerminal(page)));
    }
    if (remoteTerminal) {
      failures.push(...(await verifyRemoteTerminal(page)));
    }
    if (clicks.length === 0 && !emitLive) await page.waitForTimeout(waitMs);
    await mkdir(dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: false });
    console.log(`screenshot: ${out}`);
    if (docsShots) await captureDocsTerminalShot(page, url);
    const body = await page.locator("body").innerText();
    console.log("--- body text (first 5000 chars) ---");
    console.log(body.slice(0, 5000));
    // Post-screenshot interaction checks: scrolling behavior, then Clear (which
    // only removes the local render and would empty the deliverable image).
    if (emitLive) {
      failures.push(...(await verifyLiveScroll(page)));
      failures.push(...(await verifyLiveClear(page)));
    }
  } finally {
    if (diagnostics.length > 0) {
      console.log("--- browser diagnostics ---");
      console.log(diagnostics.slice(0, 80).join("\n"));
      for (const line of diagnostics) {
        if (isBrowserError(line)) failures.push(`browser error: ${line}`);
      }
    } else {
      console.log("--- browser diagnostics: none ---");
    }
    await browser.close();
  }
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  if (terminalFixture !== null) {
    await terminalFixture.close().catch(() => {});
  }
  if (!keep) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (output.trim().length > 0) {
      console.log("--- host server output (tail) ---");
      console.log(output.split("\n").slice(-12).join("\n"));
    }
  } else {
    console.log(`--keep: server running on ${port} (kill it manually)`);
  }
}
if (failures.length > 0) {
  console.error("--- FAILURES ---");
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  exitCode = 1;
}
process.exitCode = exitCode;
