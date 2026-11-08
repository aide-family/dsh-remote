import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTargetRegistry } from "../../lib/target-registry.js";
import { composeTargetChecks } from "../../lib/target-checks.js";

const checks = expected => [{ name: "cluster", command: "printf cluster", expected }];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-target-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, registry: createTargetRegistry({ root }) };
}

test("exact logical-host managed checks use CAS and durable private storage", async t => {
  const f = await fixture(t);
  assert.throws(() => f.registry.managedChecks("cluster-a"), { code: "TARGET_CACHE_UNINITIALIZED" });
  assert.deepEqual(await f.registry.get("cluster-a"), { host: "cluster-a", revision: 0, checks: [] });
  const one = await f.registry.save({ host: "cluster-a", expectedRevision: 0, checks: checks("a") });
  assert.equal(one.revision, 1);
  assert.deepEqual(f.registry.managedChecks({ name: "cluster-a" }), checks("a"));
  assert.deepEqual(f.registry.managedChecks("entrance-host"), []);
  await assert.rejects(f.registry.save({ host: "cluster-a", expectedRevision: 0, checks: checks("b") }), { code: "TARGET_REVISION_CONFLICT" });
  const restarted = createTargetRegistry({ root: f.root });
  assert.equal((await restarted.get("cluster-a")).checks[0].expected, "a");
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.root, "targets.json"))).mode & 0o777, 0o600);
});

test("managed removal cannot remove static checks and preserves the revision tombstone", async t => {
  const f = await fixture(t);
  const configured = [{ name: "user", command: "whoami", expected: "operator" }];
  await f.registry.save({ host: "cluster-a", expectedRevision: 0, checks: checks("a") });
  assert.equal(composeTargetChecks([configured, f.registry.managedChecks("cluster-a")]).length, 2);
  const removed = await f.registry.remove({ host: "cluster-a", expectedRevision: 1 });
  assert.equal(removed.revision, 2);
  assert.deepEqual(removed.checks, []);
  assert.deepEqual(composeTargetChecks([configured, f.registry.managedChecks("cluster-a")]), configured);
  await assert.rejects(f.registry.save({ host: "cluster-a", expectedRevision: 0, checks: checks("b") }), { code: "TARGET_REVISION_CONFLICT" });
  assert.equal((await f.registry.save({ host: "cluster-a", expectedRevision: 2, checks: checks("b") })).revision, 3);
});

test("refresh sees another registry instance; cache errors fail closed until repaired", async t => {
  const f = await fixture(t);
  await f.registry.refresh();
  const second = createTargetRegistry({ root: f.root });
  await second.save({ host: "cluster-a", expectedRevision: 0, checks: checks("b") });
  assert.deepEqual(f.registry.managedChecks("cluster-a"), []);
  await f.registry.refresh();
  assert.equal(f.registry.managedChecks("cluster-a")[0].expected, "b");
  const path = join(f.root, "targets.json");
  const original = await readFile(path, "utf8");
  await writeFile(path, "corrupt");
  await assert.rejects(f.registry.refresh());
  assert.throws(() => f.registry.managedChecks("cluster-a"));
  await writeFile(path, original);
  await f.registry.refresh();
  assert.equal(f.registry.managedChecks("cluster-a")[0].expected, "b");
});

test("unsafe hosts or commands fail before persistence; returned checks are defensive copies", async t => {
  const f = await fixture(t);
  for (const host of ["prod-*", "bad\nhost", "../../etc/passwd"]) await assert.rejects(f.registry.get(host), { code: "TARGET_HOST_INVALID" });
  await assert.rejects(f.registry.save({ host: "a", expectedRevision: 0, checks: [{ name: "bad", command: "rm -rf /", expected: "ok" }] }), { code: "TARGET_CHECK_INVALID" });
  const entry = await f.registry.save({ host: "_cluster", expectedRevision: 0, checks: checks("a") });
  entry.checks[0].expected = "caller-mutation";
  const cache = f.registry.managedChecks("_cluster");
  cache[0].expected = "other-mutation";
  assert.equal(f.registry.managedChecks("_cluster")[0].expected, "a");
});
