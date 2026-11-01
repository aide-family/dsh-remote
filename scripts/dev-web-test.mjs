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
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = join(REPO, ".dsh-test");
const PROFILE = "webtest";

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
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--click") clicks.push(args[++i]);
  else if (arg === "--clicks") clicks.push(...String(args[++i]).split(",").map((value) => value.trim()).filter(Boolean));
  else if (arg === "--wait") waitMs = Number(args[++i]);
  else if (arg === "--port") port = Number(args[++i]);
  else if (arg === "--keep") keep = true;
  else if (arg === "--emit-live") emitLive = true;
  else if (!arg.startsWith("--")) out = arg;
}

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
  if (!manifest.dsh.profile.bundles.includes("dsh-remote")) {
    manifest.dsh.profile.bundles.push("dsh-remote");
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

const childEnv = { ...process.env, DSH_HOME };
delete childEnv.DSH_PROFILE;
delete childEnv.DSH_PROFILE_DIR;

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
        for (const dismissLabel of ["继续", "知道了", "开始使用", "跳过", "关闭"]) {
          const button = page.getByRole("button", { name: dismissLabel, exact: false }).first();
          try {
            if ((await button.count()) > 0 && (await button.isVisible())) {
              await button.click();
              await page.waitForTimeout(500);
            }
          } catch {
            /* not an overlay */
          }
        }
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(300);
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
    if (clicks.length === 0 && !emitLive) await page.waitForTimeout(waitMs);
    await mkdir(dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: false });
    console.log(`screenshot: ${out}`);
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
