#!/usr/bin/env node
/**
 * Development loop for the dsh-remote management page.
 *
 * Boots the isolated `webtest` DSH Web profile (from ./.dsh-test), waits for
 * its authenticated URL, drives the page with headless Chrome (playwright-core +
 * the installed Google Chrome), optionally clicks a sidebar label, and writes a
 * screenshot. The server is stopped afterwards unless --keep is passed.
 *
 *   node scripts/dev-web-test.mjs [out.png] [--click "远程运维"] [--wait 3000] [--port 53991] [--keep]
 *
 * Prints the page body text and every browser console warning/error so a broken
 * client bundle is diagnosable without a manual browser.
 */
import { spawn, execFileSync } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = join(REPO, ".dsh-test");
const PROFILE = "webtest";

const args = process.argv.slice(2);
let out = join(REPO, ".cache", "shots", "web.png");
const clicks = [];
let waitMs = 3000;
let port = 53991;
let keep = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--click") clicks.push(args[++i]);
  else if (arg === "--clicks") clicks.push(...String(args[++i]).split(",").map((value) => value.trim()).filter(Boolean));
  else if (arg === "--wait") waitMs = Number(args[++i]);
  else if (arg === "--port") port = Number(args[++i]);
  else if (arg === "--keep") keep = true;
  else if (!arg.startsWith("--")) out = arg;
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
    if (clicks.length === 0) await page.waitForTimeout(waitMs);
    await mkdir(dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: false });
    console.log(`screenshot: ${out}`);
    const body = await page.locator("body").innerText();
    console.log("--- body text (first 5000 chars) ---");
    console.log(body.slice(0, 5000));
  } finally {
    if (diagnostics.length > 0) {
      console.log("--- browser diagnostics ---");
      console.log(diagnostics.slice(0, 80).join("\n"));
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
process.exitCode = exitCode;
