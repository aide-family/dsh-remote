#!/usr/bin/env node
/**
 * Regenerate the README screenshots against an isolated, synthetic DSH profile.
 *
 *   node scripts/docs-screenshots.mjs
 *
 * The profile lives under `.cache/docs-home` and deliberately:
 *   - disables ~/.ssh/config discovery,
 *   - contains only documentation IPs (`192.0.2.0/24`, `198.51.100.0/24`) plus a
 *     loopback SSH fixture,
 *   - has no linked DeepSeek credentials (so the UI cannot show an account name),
 *   - seeds a synthetic audit trail instead of recording real operations.
 *
 * Screenshots are written to `docs/assets/`. The script fails if the rendered
 * page contains anything that looks like a real host, path, or account, so an
 * unreviewed capture cannot silently end up in the README.
 *
 * The native interactive terminal needs the Host process to allocate a POSIX
 * PTY. Run this script with full process access when the agent sandbox denies
 * `posix_openpt`; otherwise the interactive-terminal capture is skipped and the
 * other three images are still produced.
 */
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { startSshServer } from "../test/fixtures/ssh-server.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS_HOME = join(REPO, ".cache", "docs-home");
const PROFILE = "docs";
const PORT = Number(process.env.DOCS_PORT ?? 53995);
const OUT_DIR = join(REPO, "docs", "assets");
const FIXTURE_HOST = "demo-node";
const FIXTURE_PASSWORD = "testpass";

/** Synthetic inventory: RFC 5737 documentation addresses only. */
const HOSTS = [
  {
    name: "web-prod-1",
    host: "192.0.2.10",
    username: "deploy",
    identityFile: "~/.ssh/id_ed25519_demo",
    tags: ["prod", "web"],
    description: "primary web node",
  },
  {
    name: "db-staging",
    host: "198.51.100.24",
    username: "dba",
    passwordEnv: "DB_SSH_PASSWORD",
    tags: ["staging", "db"],
    description: "read replica",
  },
];

/** Synthetic operation history rendered by the management page. */
const AUDIT_ROWS = [
  ["remote_hosts", "—", "hosts", "", "ok", "allowed hosts", 1],
  ["remote_exec", "web-prod-1", "exec", "low", "ok", "uptime", 243],
  ["remote_list", "web-prod-1", "list", "low", "ok", "/srv/app/releases", 18],
  ["remote_read", "web-prod-1", "read", "low", "ok", "/etc/nginx/nginx.conf", 23],
  ["remote_exec", "db-staging", "exec", "high", "denied", "systemctl restart postgresql", 2],
  ["remote_exec", "db-staging", "exec", "gray", "ok", "systemctl status postgresql --no-pager", 211],
  ["remote_shell_open", FIXTURE_HOST, "shell open", "execute", "ok", FIXTURE_HOST, 866],
  ["remote_shell_send", FIXTURE_HOST, "shell send", "low", "ok", "printf 'ready'", 806],
  ["remote_shell_close", FIXTURE_HOST, "shell close", "", "ok", "remote-shell-1", 49],
];

const LIVE_EMITS = [
  {
    command: "uptime",
    host: "web-prod-1",
    lines: [" 10:24:01 up 42 days,  3:15,  1 user,  load average: 0.18, 0.12, 0.09"],
  },
  { command: "df -h /", host: "web-prod-1", lines: ["/dev/vda1  80G  31G  45G  41% /"] },
  {
    command: "systemctl status nginx --no-pager",
    host: "db-staging",
    lines: ["● nginx.service - A high performance web server", "     Active: active (running)"],
  },
];

/** Strings that must never appear in a published capture. */
const PRIVATE_PATTERNS = [
  { label: "real LAN address", re: /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/u },
  { label: "private SSH inventory address", re: /192\.168\.\d{1,3}\.\d{1,3}/u },
  { label: "local home path", re: /(?:\/Users\/|\/home\/)[^\s/]+/u },
  { label: "local Windows profile path", re: /[A-Z]:\\Users\\[^\s\\]+/iu },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Create the isolated profile on first use and sync the working tree into it. */
async function ensureProfile(profileDir) {
  await mkdir(DOCS_HOME, { recursive: true });
  if (!(await exists(join(profileDir, "package.json")))) {
    execFileSync("dsh", ["--profile", PROFILE, "--from-default-profile", "web", "--dump-config"], {
      stdio: "inherit",
      env: { ...process.env, DSH_HOME: DOCS_HOME },
    });
  }
  execFileSync("bash", [join(REPO, "scripts", "sync-profile.sh"), PROFILE], {
    stdio: "inherit",
    env: { ...process.env, DSH_DEV_HOME: DOCS_HOME },
  });

  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies ??= {};
  manifest.dependencies["@aide-family/dsh-remote"] = "file:.";
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= [];
  if (!manifest.dsh.profile.bundles.includes("@aide-family/dsh-remote")) {
    manifest.dsh.profile.bundles.push("@aide-family/dsh-remote");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Write the synthetic inventory/configuration and audit trail. */
async function seedData(profileDir, fixture) {
  const hosts = [
    ...HOSTS,
    {
      name: FIXTURE_HOST,
      host: "127.0.0.1",
      port: fixture.port,
      username: fixture.username,
      passwordEnv: "DOCS_SSH_PASSWORD",
      tags: ["demo"],
      description: "local demo node",
    },
  ];
  const patch = [
    "- id: dsh-remote",
    '  name: "@aide-family/dsh-remote"',
    "  config:",
    "    includeSshConfig: false",
    "    devLiveEvents: true",
    "    liveTerminal: true",
    "    autoOpenLiveTerminal: true",
    "    userTerminal: true",
    "    hosts:",
    ...hosts.flatMap((host) => [
      `      - name: ${host.name}`,
      `        host: "${host.host}"`,
      ...(host.port === undefined ? [] : [`        port: ${host.port}`]),
      `        username: "${host.username}"`,
      ...(host.identityFile === undefined ? [] : [`        identityFile: "${host.identityFile}"`]),
      ...(host.passwordEnv === undefined ? [] : [`        passwordEnv: "${host.passwordEnv}"`]),
      `        tags: [${host.tags.join(", ")}]`,
      `        description: "${host.description}"`,
    ]),
    "",
  ].join("\n");
  await writeFile(join(profileDir, "cordis.patch.yml"), patch, "utf8");

  const remoteDir = join(DOCS_HOME, "remote");
  await mkdir(remoteDir, { recursive: true });
  await rm(join(remoteDir, "hosts.json"), { force: true });
  const now = Date.now();
  const lines = AUDIT_ROWS.map((row, index) => {
    const [tool, host, action, risk, outcome, detail, durationMs] = row;
    return JSON.stringify({
      id: index + 1,
      time: now - (AUDIT_ROWS.length - 1 - index) * 60_000,
      tool,
      host,
      action,
      risk,
      outcome,
      detail,
      detailFull: detail,
      durationMs,
    });
  });
  await writeFile(join(remoteDir, "audit.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function startServer(childEnv) {
  const child = spawn("dsh", ["--profile", PROFILE, "--no-open", "--port", String(PORT)], {
    cwd: REPO,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const urlPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dsh web did not print a URL:\n${output}`)),
      45_000,
    );
    const scan = () => {
      const match = output.match(/dsh web: (http:\/\/\S+)/u);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", (chunk) => {
      output += chunk;
      scan();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      scan();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dsh web exited with ${code}:\n${output}`));
    });
  });
  return { child, urlPromise };
}

/** Dismiss first-run overlays (preview notes, guide masks). */
async function dismissOverlays(page) {
  for (const label of ["继续", "知道了", "开始使用", "跳过", "关闭"]) {
    const button = page.getByRole("button", { name: label, exact: false }).first();
    try {
      if ((await button.count()) > 0 && (await button.isVisible())) {
        await button.click({ force: true });
        await page.waitForTimeout(400);
      }
    } catch {
      /* not an overlay */
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function openOpsPage(page) {
  let entry = page.getByText("远程运维", { exact: false }).first();
  if ((await entry.count()) === 0) {
    const more = page.getByText("更多", { exact: true }).first();
    if ((await more.count()) > 0) {
      await more.click({ force: true });
      await page.waitForTimeout(500);
      entry = page.getByText("远程运维", { exact: false }).first();
    }
  }
  await entry.waitFor({ state: "visible", timeout: 15_000 });
  await entry.click({ force: true });
  await page.waitForTimeout(1_500);
}

/** Fail loudly if the rendered page leaks anything that looks private. */
async function assertPrivateFree(page, label) {
  const text = await page.locator("body").innerText();
  const hits = PRIVATE_PATTERNS.filter((pattern) => pattern.re.test(text)).map(
    (pattern) => pattern.label,
  );
  if (hits.length > 0) {
    throw new Error(`${label}: refusing to publish a capture with ${hits.join(", ")}`);
  }
}

async function capture(page, name) {
  await mkdir(OUT_DIR, { recursive: true });
  await assertPrivateFree(page, name);
  const path = join(OUT_DIR, name);
  await page.screenshot({ path, animations: "disabled" });
  console.log(`docs-screenshots: wrote ${path}`);
}

async function emitLive(page, body) {
  return page.evaluate(async function emit(input) {
    const response = await fetch("/dsh-remote/api", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }, body);
}

async function main() {
  const profileDir = join(DOCS_HOME, "profiles", PROFILE);
  await ensureProfile(profileDir);

  const fixture = await startSshServer({ password: FIXTURE_PASSWORD });
  const childEnv = {
    ...process.env,
    DSH_HOME: DOCS_HOME,
    DOCS_SSH_PASSWORD: FIXTURE_PASSWORD,
  };
  delete childEnv.DSH_PROFILE;
  delete childEnv.DSH_PROFILE_DIR;

  let server;
  let browser;
  try {
    await seedData(profileDir, fixture);
    server = startServer(childEnv);
    const url = await server.urlPromise;
    console.log(`docs-screenshots: web ready at ${url}`);

    const candidates = [
      process.env.CHROME_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].filter(Boolean);
    let executablePath;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        executablePath = candidate;
        break;
      }
    }
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
    });
    const diagnostics = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        diagnostics.push(`[console.${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => diagnostics.push(`[pageerror] ${error.message}`));
    page.on("dialog", (dialog) => dialog.accept().catch(() => {}));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await dismissOverlays(page);

    // 1. Remote Ops management page.
    await openOpsPage(page);
    await capture(page, "remote-ops.png");

    // 2. Host manager form (add a managed connection).
    const createButton = page.locator('[data-host-action="create"]').first();
    if ((await createButton.count()) > 0) {
      await createButton.click({ force: true });
      const saveButton = page.locator('[data-host-form-action="save"]').first();
      await saveButton.waitFor({ state: "visible", timeout: 10_000 });
      const fill = async (key, value) => {
        const field = page.locator(`[data-host-field="${key}"]`).first();
        if ((await field.count()) > 0) await field.fill(value);
      };
      await fill("name", "web-prod-2");
      await fill("host", "203.0.113.15");
      await fill("username", "deploy");
      await fill("identityFile", "~/.ssh/id_ed25519");
      await fill("tags", "prod, web");
      await fill("description", "secondary web node");
      await page.waitForTimeout(500);
      await capture(page, "host-manager.png");
      const cancel = page.locator('[data-host-form-action="cancel"]').first();
      if ((await cancel.count()) > 0) await cancel.click({ force: true });
      await page.waitForTimeout(500);
    } else {
      console.warn("docs-screenshots: add-host control missing; skipped host-manager.png");
    }

    // 3. Per-host audit modal.
    const auditButton = page.locator('[data-host-action="audit"]').first();
    if ((await auditButton.count()) > 0) {
      await auditButton.click({ force: true });
      const audit = page.locator("[data-dsh-remote-audit]").first();
      await audit.waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForTimeout(500);
      await capture(page, "host-audit.png");
      const close = page
        .locator("[data-dsh-remote-audit] button")
        .filter({ hasText: "关闭" })
        .first();
      if ((await close.count()) > 0) await close.click({ force: true });
      await page.waitForTimeout(500);
    } else {
      console.warn("docs-screenshots: audit action missing; skipped host-audit.png");
    }

    // 3. Live terminal mirror in the right sidebar.
    await page.getByText("新会话", { exact: true }).first().click({ force: true });
    await page.waitForTimeout(1_800);
    const expand = page.locator("[data-sidebar-right-expand]").first();
    if ((await expand.count()) > 0) {
      await expand.click({ force: true });
      await page.waitForTimeout(900);
    }
    for (const body of LIVE_EMITS) {
      const result = await emitLive(page, { method: "live.emit", host: body.host, kind: "exec", ...body });
      if (result.status !== 200 || result.payload?.ok !== true) {
        throw new Error(`live.emit failed: HTTP ${result.status} ${JSON.stringify(result.payload)}`);
      }
      await page.waitForTimeout(900);
    }
    const panel = page.locator("[data-dsh-remote-live]").first();
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await capture(page, "live-terminal.png");

    // 4. Interactive native terminal (needs a local PTY; skipped when denied).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_500);
    await dismissOverlays(page);
    const expandAgain = page.locator("[data-sidebar-right-expand]").first();
    if ((await expandAgain.count()) > 0) {
      await expandAgain.click({ force: true });
      await page.waitForTimeout(800);
    }
    if ((await page.locator("[data-dsh-remote-live]").count()) === 0) {
      const guide = page.locator('[data-sidebar-right-guide-entry="dsh-remote-live"]').first();
      if ((await guide.count()) > 0) {
        await guide.click({ force: true });
        await page.waitForTimeout(1_000);
      }
    }
    const picker = page.locator("[data-remote-terminal-host]").first();
    if ((await picker.count()) > 0) {
      await picker.selectOption(FIXTURE_HOST);
      const openButton = page.locator('[data-terminal-action="open"]').first();
      if ((await openButton.count()) > 0) await openButton.click({ force: true });
      const terminal = page.locator("[data-sidebar-terminal]").first();
      const ready = await waitForCondition(
        async () => (await terminal.count()) > 0 && (await terminal.innerText()).includes("fixture-shell-ready"),
        25_000,
      );
      if (ready) {
        const screen = page.locator("[data-sidebar-terminal] .xterm-screen").first();
        await screen.click({ force: true });
        await page.keyboard.type("clear", { delay: 20 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(700);
        await page.keyboard.type('echo "connected: demo-node"', { delay: 20 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        await page.keyboard.type('echo "load average: 0.18 0.12 0.09"', { delay: 20 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1_000);
        await capture(page, "remote-terminal.png");
      } else {
        console.warn(
          "docs-screenshots: native terminal unavailable (PTY denied?); skipped remote-terminal.png",
        );
      }
    } else {
      console.warn("docs-screenshots: terminal host picker missing; skipped remote-terminal.png");
    }

    const meaningful = diagnostics.filter(
      (line) => !line.includes("posix_openpt") && !line.includes("Failed to load resource"),
    );
    if (meaningful.length > 0) {
      console.log("--- browser diagnostics ---");
      console.log(meaningful.slice(0, 40).join("\n"));
    }
  } finally {
    await browser?.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (server !== undefined) {
      server.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

/** Poll `fn` until truthy or the timeout expires. */
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

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
