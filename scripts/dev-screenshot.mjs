#!/usr/bin/env node
/**
 * Development-only browser check for the dsh-remote client page.
 *
 *   node scripts/dev-screenshot.mjs "<url-with-token>" out.png [--click "Remote Ops"] [--wait 1500]
 *
 * Uses playwright-core with the locally installed Google Chrome (no browser
 * download). Prints console errors/requests to stdout so a broken client bundle
 * is diagnosable from the terminal.
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const [url, out = "shot.png", ...rest] = process.argv.slice(2);
if (url === undefined) {
  console.error('usage: node scripts/dev-screenshot.mjs "<url>" <out.png> [--click <text>] [--wait <ms>] [--width <px>]');
  process.exit(2);
}
let clickText;
let waitMs = 1200;
let width = 1440;
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--click") clickText = rest[++i];
  else if (rest[i] === "--wait") waitMs = Number(rest[++i]);
  else if (rest[i] === "--width") width = Number(rest[++i]);
}

const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    /* next */
  }
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check"],
});
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
const consoleLines = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning" || message.type() === "info" || message.type() === "log") {
    consoleLines.push(`[console.${message.type()}] ${message.text()}`);
  }
});
page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) consoleLines.push(`[http ${response.status()}] ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(waitMs);
  if (clickText !== undefined) {
    const target = page.getByText(clickText, { exact: false }).first();
    await target.waitFor({ state: "visible", timeout: 15_000 });
    await target.click();
    await page.waitForTimeout(waitMs);
  }
  await page.screenshot({ path: out, fullPage: false });
  const title = await page.title();
  const bodyText = (await page.locator("body").innerText()).slice(0, 4000);
  console.log(`screenshot: ${out}`);
  console.log(`title: ${title}`);
  console.log("--- body text (first 4000 chars) ---");
  console.log(bodyText);
  if (consoleLines.length > 0) {
    console.log("--- browser diagnostics ---");
    console.log(consoleLines.join("\n"));
  } else {
    console.log("--- browser diagnostics: none ---");
  }
} finally {
  await browser.close();
}
