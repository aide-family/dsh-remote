import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { opsWorkspaceDirectory, prepareOpsWorkspace } from "../../lib/ops-workspace.js";

test("fixed operations workspace is scoped to DSH home, never the current project", () => {
  assert.equal(opsWorkspaceDirectory("/fixture/dsh"), resolve("/fixture/dsh/workspaces/remote-ops"));
  assert.equal(opsWorkspaceDirectory("/fixture/other-profile-home"), resolve("/fixture/other-profile-home/workspaces/remote-ops"));
});

test("directory preparation is idempotent and preserves existing operations files", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-ops-workspace-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = opsWorkspaceDirectory(home);
  const first = await prepareOpsWorkspace(directory);
  assert.equal((await stat(first.cwd)).isDirectory(), true);
  if (process.platform !== "win32") assert.equal((await stat(first.cwd)).mode & 0o777, 0o700);
  await writeFile(join(first.cwd, "notes.txt"), "keep");
  assert.deepEqual(await prepareOpsWorkspace(directory), first);
  assert.equal((await stat(join(first.cwd, "notes.txt"))).size, 4);
});

test("an existing regular file blocks workspace preparation instead of using another directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-ops-file-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = opsWorkspaceDirectory(home);
  await mkdir(join(home, "workspaces"));
  await writeFile(directory, "not a directory");
  await assert.rejects(prepareOpsWorkspace(directory));
  assert.equal((await stat(directory)).isFile(), true);
});
