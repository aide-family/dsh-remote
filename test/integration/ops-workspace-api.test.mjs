import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagementApi } from "../../lib/api.js";

test("fixed workspace preparation is fenced and ignores browser-supplied directories", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-ops-api-"));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let forbidden = true;
  const handler = createManagementApi({ config: {}, ctx: { get() {
    return { requestRejection() { return forbidden ? { reason: "denied" } : undefined; } };
  } } });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/dsh-remote/api`;
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "workspace.prepare", cwd: join(home, "untrusted"), path: join(home, "untrusted") }) });
  assert.equal((await post()).status, 403);
  await assert.rejects(stat(join(home, "workspaces")), { code: "ENOENT" });
  forbidden = false;
  const response = await post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.cwd, await realpath(join(home, "workspaces", "remote-ops")));
  assert.equal((await stat(body.result.cwd)).isDirectory(), true);
  await assert.rejects(stat(join(home, "untrusted")), { code: "ENOENT" });
  assert.deepEqual(await (await post()).json(), body);
});
