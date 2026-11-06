import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../scripts/docs-screenshots.mjs", import.meta.url), "utf8");
const declaration = source.match(/const PRIVATE_PATTERNS = (\[[\s\S]*?\n\]);/);
assert.ok(declaration, "privacy guard declaration must exist");
const patterns = vm.runInNewContext(declaration[1]);
const isPrivate = (value) => patterns.some(({ re }) => re.test(value));

test("screenshot privacy guards cover RFC1918 ranges without blocking documentation IPs", () => {
  for (const value of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) {
    assert.equal(isPrivate(value), true, value);
  }
  for (const value of ["192.0.2.10", "198.51.100.10", "203.0.113.10", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isPrivate(value), false, value);
  }
});

test("screenshot privacy guards reject generic local user paths without hardcoded identities", () => {
  for (const value of ["/Users/example-user/project", "/home/example-user/project", "C:\\Users\\example-user\\project"]) {
    assert.equal(isPrivate(value), true, value);
  }
  assert.equal(isPrivate("/srv/app/releases"), false);
});
