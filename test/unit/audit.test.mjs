/**
 * Audit log unit tests: ring bounds, ordering, detail bounding, clear, and
 * JSONL persistence (durable append + reload of the retained tail).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { DETAIL_FULL_MAX, boundDetail, boundDetailFull, createAuditLog } from "../../lib/audit.js";

test("records newest first and bounds the ring", () => {
  const audit = createAuditLog({ limit: 3 });
  for (let i = 1; i <= 5; i += 1) {
    audit.record({ tool: "remote_exec", host: "h", action: "exec", risk: "low", outcome: "ok", detail: `cmd-${i}`, durationMs: i });
  }
  const entries = audit.list({ limit: 10 });
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.detail),
    ["cmd-5", "cmd-4", "cmd-3"],
  );
  assert.equal(audit.size, 3);
  assert.equal(entries[0].id, 5);
});

test("normalizes outcomes and bounds the detail", () => {
  const audit = createAuditLog();
  const entry = audit.record({
    tool: "remote_exec",
    host: "box",
    action: "exec",
    risk: "high",
    outcome: "denied",
    detail: `line one\n${"x".repeat(500)}`,
    durationMs: 12.7,
  });
  assert.equal(entry.outcome, "denied");
  assert.equal(entry.durationMs, 13);
  assert.ok(entry.detail.length <= 300);
  assert.ok(entry.detail.endsWith("…"));

  const error = audit.record({ tool: "t", outcome: "error" });
  assert.equal(error.outcome, "error");
  const ok = audit.record({ tool: "t", outcome: "something-else" });
  assert.equal(ok.outcome, "unknown");
  assert.equal(ok.host, "—");
  assert.equal(boundDetail("  a   b  "), "a b");
});

test("clear empties memory", () => {
  const audit = createAuditLog();
  audit.record({ tool: "remote_exec" });
  assert.equal(audit.size, 1);
  assert.deepEqual(audit.clear(), { cleared: true });
  assert.equal(audit.size, 0);
  assert.equal(audit.list().length, 0);
});

test("appends JSONL durably and reloads the retained tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-audit-"));
  const filePath = join(dir, "remote", "audit.jsonl");
  try {
    const first = createAuditLog({ limit: 10, filePath });
    first.record({ tool: "remote_exec", host: "me", action: "exec", risk: "low", outcome: "ok", detail: "uptime", durationMs: 3 });
    first.record({ tool: "remote_shell_send", host: "me", action: "shell send", risk: "low", outcome: "ok", detail: "echo hi", durationMs: 4 });
    await first.flush();

    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).tool, "remote_exec");

    const second = createAuditLog({ limit: 10, filePath });
    await second.load();
    const restored = second.list({ limit: 10 });
    assert.equal(restored.length, 2);
    assert.equal(restored[0].tool, "remote_shell_send");
    assert.equal(restored[1].tool, "remote_exec");
    // New ids continue after the restored maximum.
    const third = second.record({ tool: "remote_hosts", outcome: "ok" });
    assert.equal(third.id, 3);

    // A smaller limit compacts the file to the retained tail on load.
    const thirdLog = createAuditLog({ limit: 1, filePath });
    await thirdLog.load();
    await thirdLog.flush();
    const compacted = (await readFile(filePath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    assert.equal(compacted.length, 1);
    assert.equal(JSON.parse(compacted[0]).tool, "remote_hosts");

    // Audit clear truncates the file.
    thirdLog.clear();
    assert.equal(await readFile(filePath, "utf8"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tolerates a torn or invalid line on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-audit-torn-"));
  const filePath = join(dir, "audit.jsonl");
  try {
    await writeFile(
      filePath,
      `${JSON.stringify({ id: 1, time: Date.now(), tool: "remote_exec", host: "me", action: "exec", risk: "low", outcome: "ok", detail: "", durationMs: 1 })}\n{not json\n`,
      "utf8",
    );
    const audit = createAuditLog({ limit: 5, filePath });
    await audit.load();
    assert.equal(audit.size, 1);
    assert.equal(audit.list()[0].tool, "remote_exec");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("audit host filter, offset and count", () => {
  /** @returns {ReturnType<typeof createAuditLog>} */
  function seededAudit() {
    const audit = createAuditLog({ limit: 100 });
    audit.record({ tool: "remote_exec", host: "web-1", action: "exec", risk: "low", detail: "a" });
    audit.record({ tool: "remote_read", host: "db-1", action: "read", risk: "read", detail: "b" });
    audit.record({ tool: "remote_exec", host: "web-1", action: "exec", risk: "low", detail: "c" });
    audit.record({ tool: "terminal", host: "web-1", action: "open", risk: "read", detail: "d" });
    audit.record({ tool: "remote_exec", host: "WEB-1", action: "exec", risk: "low", detail: "e" });
    return audit;
  }

  it("filters by exact host, newest first, and counts the matches", () => {
    const audit = seededAudit();
    const entries = audit.list({ host: "web-1" });
    assert.ok(Array.isArray(entries));
    assert.deepEqual(entries.map((entry) => entry.detail), ["d", "c", "a"]);
    assert.equal(audit.count({ host: "web-1" }), 3);
  });

  it("is exact: no globs and no case folding", () => {
    const audit = seededAudit();
    assert.deepEqual(audit.list({ host: "WEB-1" }).map((entry) => entry.detail), ["e"]);
    assert.equal(audit.count({ host: "WEB-1" }), 1);
    assert.deepEqual(audit.list({ host: "web-*" }), []);
    assert.equal(audit.count({ host: "web-*" }), 0);
    assert.deepEqual(audit.list({ host: "web" }), []);
    assert.equal(audit.count({ host: "web" }), 0);
    assert.deepEqual(audit.list({ host: "nope" }), []);
    assert.equal(audit.count({ host: "nope" }), 0);
  });

  it("pages with offset after filtering", () => {
    const audit = seededAudit();
    assert.deepEqual(
      audit.list({ host: "web-1", limit: 2, offset: 1 }).map((entry) => entry.detail),
      ["c", "a"],
    );
    assert.deepEqual(audit.list({ host: "web-1", offset: 2 }).map((entry) => entry.detail), ["a"]);
    assert.deepEqual(audit.list({ host: "web-1", offset: 99 }), []);
    assert.deepEqual(audit.list({ limit: 2, offset: 1 }).map((entry) => entry.detail), ["d", "c"]);
    // The whole (unfiltered) page still reports the total through count().
    assert.equal(audit.count(), 5);
  });

  it("stays backwards compatible with list()/list({ limit }) and count()", () => {
    const audit = seededAudit();
    assert.ok(Array.isArray(audit.list()));
    assert.equal(audit.list().length, 5);
    assert.equal(audit.list({ limit: 2 }).length, 2);
    assert.deepEqual(audit.list({ limit: 2 }).map((entry) => entry.detail), ["e", "d"]);
    assert.equal(audit.count(), 5);
    assert.equal(audit.count({}), 5);
    assert.equal(audit.count({ host: undefined }), 5);
    assert.equal(audit.count({ host: "" }), 5);
  });

  it("falls back for invalid limit/offset values", () => {
    const audit = seededAudit();
    assert.equal(audit.list({ limit: 0 }).length, 5);
    assert.equal(audit.list({ limit: -1 }).length, 5);
    assert.equal(audit.list({ limit: 1.5 }).length, 5);
    assert.equal(audit.list({ limit: "2" }).length, 5);
    assert.deepEqual(audit.list({ offset: -5 }).map((entry) => entry.detail), ["e", "d", "c", "b", "a"]);
    assert.deepEqual(audit.list({ offset: 1.5 }).map((entry) => entry.detail), ["e", "d", "c", "b", "a"]);
  });

  it("count reflects retention bounds and clear()", () => {
    const audit = createAuditLog({ limit: 2 });
    audit.record({ tool: "t", host: "a" });
    audit.record({ tool: "t", host: "b" });
    audit.record({ tool: "t", host: "a" });
    assert.equal(audit.count({ host: "a" }), 1, "the evicted first 'a' entry is not counted");
    assert.equal(audit.count(), 2);
    audit.clear();
    assert.equal(audit.count(), 0);
    assert.equal(audit.count({ host: "a" }), 0);
  });
});

test("detailFull keeps the raw subject (whitespace intact) while detail stays one-line", () => {
  const audit = createAuditLog({ limit: 5 });
  const raw = `line one\n\tline two\r\n${"x".repeat(20_000)}`;
  const entry = audit.record({ tool: "remote_exec", host: "box", action: "exec", detail: raw });
  assert.equal(entry.detail.length, 300);
  assert.equal(entry.detail.includes("\n"), false);
  assert.equal(entry.detailFull.startsWith("line one\n\tline two\r\n"), true);
  assert.ok(entry.detailFull.length <= DETAIL_FULL_MAX);
  assert.ok(entry.detailFull.endsWith("…"));
  assert.equal(entry.detailFull.length, DETAIL_FULL_MAX);
  assert.equal(boundDetailFull("  a\n b  "), "  a\n b  ");
  assert.equal(boundDetailFull(null), "");
  assert.equal(boundDetailFull(42), "42");
});

test("list() omits detailFull unless full: true and tolerates legacy entries", async () => {
  const audit = createAuditLog({ limit: 10 });
  audit.record({ tool: "remote_exec", host: "me", action: "exec", detail: "echo hi\nsecond line" });
  const plain = audit.list();
  assert.equal(Object.prototype.hasOwnProperty.call(plain[0], "detailFull"), false);
  assert.deepEqual(audit.list({ limit: 1, full: false })[0].detail, "echo hi second line");
  const full = audit.list({ full: true });
  assert.equal(full[0].detailFull, "echo hi\nsecond line");
  assert.equal(full[0].detail, "echo hi second line");

  const dir = await mkdtemp(join(tmpdir(), "dsh-remote-audit-full-"));
  const filePath = join(dir, "audit.jsonl");
  try {
    const legacy = {
      id: 1,
      time: Date.now() - 1_000,
      tool: "remote_exec",
      host: "me",
      action: "exec",
      risk: "low",
      outcome: "ok",
      detail: "legacy one-line",
      durationMs: 1,
    };
    const written = createAuditLog({ limit: 10, filePath });
    written.record({ tool: "remote_shell_send", host: "me", action: "shell send", detail: "printf 'a\\nb'\n" });
    await written.flush();
    await writeFile(filePath, `${JSON.stringify(legacy)}\n${await readFile(filePath, "utf8")}`, "utf8");

    const restored = createAuditLog({ limit: 10, filePath });
    await restored.load();
    const entries = restored.list({ full: true });
    assert.equal(entries.length, 2);
    assert.equal(entries[1].detail, "legacy one-line");
    assert.equal(entries[1].detailFull, "legacy one-line", "a legacy line is backfilled from detail");
    assert.equal(entries[0].detailFull, "printf 'a\\nb'\n");
    // The default page never ships the raw field, even for restored entries.
    assert.equal(Object.prototype.hasOwnProperty.call(restored.list()[1], "detailFull"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
