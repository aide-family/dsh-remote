import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One stable local directory for remote operations, independent of current cwd. */
export function opsWorkspaceDirectory(home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh")) {
  return resolve(home, "workspaces", "remote-ops");
}

/** Idempotent; never accepts a browser-supplied path or touches remote SSH. */
export async function prepareOpsWorkspace(directory = opsWorkspaceDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cwd = await realpath(directory);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Remote operations workspace is not a directory");
  return { cwd };
}
