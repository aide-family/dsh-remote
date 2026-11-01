/**
 * Unit tests for `lib/host-registry.js` (v0.5 managed host registry):
 * CRUD, validation, secret rejection, atomic 0600 persistence, corrupt/missing
 * file tolerance, error codes and load idempotency.
 *
 * Run with: node --test test/unit/host-registry.test.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createHostRegistry } from "../../lib/host-registry.js";

/** @type {string} */
let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-remote-registry-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** @returns {string} */
function registryPath() {
  return join(dir, "remote", "hosts.json");
}

/** @returns {{ messages: string[], warn: (message: string) => void }} */
function captureLogger() {
  /** @type {string[]} */
  const messages = [];
  return { messages, warn: (message) => messages.push(String(message)) };
}

/** @returns {ReturnType<typeof createHostRegistry>} */
function makeRegistry(logger) {
  return createHostRegistry({ filePath: registryPath(), logger });
}

/**
 * @param {Promise<unknown> | (() => Promise<unknown>)} promiseOrFactory
 * @param {string} code
 * @param {RegExp} [pattern]
 */
async function rejectsWithCode(promiseOrFactory, code, pattern) {
  await assert.rejects(promiseOrFactory, (error) => {
    assert.equal(/** @type {any} */ (error)?.code, code, `unexpected error: ${error?.message ?? String(error)}`);
    if (pattern !== undefined) assert.match(String(/** @type {any} */ (error).message), pattern);
    return true;
  });
}

/** @param {string} [path] @returns {Promise<any>} */
async function readPayload(path = registryPath()) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** A minimal valid host input. @param {Record<string, unknown>} [overrides] */
function hostInput(overrides = {}) {
  return { name: "prod-web-1", host: "10.0.0.11", ...overrides };
}

describe("host registry persistence", () => {
  it("tolerates a missing file without creating it", async () => {
    const registry = makeRegistry();
    assert.deepEqual(await registry.load(), []);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get("prod-web-1"), undefined);
    await assert.rejects(stat(registryPath()), (error) => /** @type {any} */ (error).code === "ENOENT");
  });

  it("creates a managed record and persists an atomic 0600 JSON file", async () => {
    const logger = captureLogger();
    const registry = makeRegistry(logger);
    const created = await registry.create({
      name: "prod-web-1",
      host: "  10.0.0.11  ",
      port: 2222,
      username: " ops ",
      identityFile: "~/.ssh/prod_ed25519",
      passwordEnv: "PROD_WEB_PASSWORD",
      passphraseEnv: "PROD_KEY_PASSPHRASE",
      proxyJump: ["bastion.example.com", "admin@jump.example.com:2200"],
      tags: ["prod", "web"],
      description: " primary web node ",
    });

    assert.equal(created.name, "prod-web-1");
    assert.equal(created.host, "10.0.0.11");
    assert.equal(created.port, 2222);
    assert.equal(created.username, "ops");
    assert.equal(created.identityFile, "~/.ssh/prod_ed25519");
    assert.equal(created.passwordEnv, "PROD_WEB_PASSWORD");
    assert.equal(created.passphraseEnv, "PROD_KEY_PASSPHRASE");
    assert.deepEqual(created.proxyJump, ["bastion.example.com", "admin@jump.example.com:2200"]);
    assert.deepEqual(created.tags, ["prod", "web"]);
    assert.equal(created.description, "primary web node");
    assert.equal(created.managed, true);
    assert.equal(typeof created.createdAt, "number");
    assert.equal(created.updatedAt, created.createdAt);
    // Only environment-variable NAMES are ever persisted.
    assert.equal(JSON.stringify(created).includes("hunter2"), false);

    const payload = await readPayload();
    assert.equal(payload.version, 1);
    assert.equal(payload.hosts.length, 1);
    assert.equal(payload.hosts[0].name, "prod-web-1");
    assert.equal(payload.hosts[0].managed, true);

    if (process.platform !== "win32") {
      const mode = (await stat(registryPath())).mode & 0o777;
      assert.equal(mode, 0o600, "registry file must be private (0600)");
      const directoryMode = (await stat(dirname(registryPath()))).mode & 0o777;
      assert.equal(directoryMode, 0o700, "registry directory must be private (0700)");
    }
    // Atomic write leaves no temp files behind.
    assert.deepEqual(await readdir(dirname(registryPath())), ["hosts.json"]);
    assert.equal(logger.messages.length, 0);
  });

  it("defaults the port to 22 and drops empty optional fields", async () => {
    const registry = makeRegistry();
    const created = await registry.create({
      name: "box",
      host: "box.internal",
      username: "",
      identityFile: "   ",
      passwordEnv: "",
      passphraseEnv: "",
      proxyJump: "",
      tags: [],
      description: "  ",
    });
    assert.equal(created.port, 22);
    for (const key of ["username", "identityFile", "passwordEnv", "passphraseEnv", "proxyJump", "tags", "description"]) {
      assert.equal(key in created, false, `${key} should be omitted when empty`);
    }
  });

  it("round-trips through a fresh registry instance, sorted by name", async () => {
    const first = makeRegistry();
    const b = await first.create(hostInput({ name: "beta", host: "beta.internal" }));
    const a = await first.create(hostInput({ name: "alpha", host: "alpha.internal", tags: ["x"] }));

    const payload = await readPayload();
    assert.deepEqual(payload.hosts.map((host) => host.name), ["alpha", "beta"], "file is written sorted");

    const second = makeRegistry();
    await second.load();
    assert.deepEqual(second.list(), [a, b].sort((left, right) => (left.name < right.name ? -1 : 1)));
    assert.deepEqual(second.get("ALPHA"), a);
  });

  it("serializes concurrent creates without losing an entry", async () => {
    const registry = makeRegistry();
    const created = await Promise.all([
      registry.create(hostInput({ name: "one", host: "one.internal" })),
      registry.create(hostInput({ name: "two", host: "two.internal" })),
      registry.create(hostInput({ name: "three", host: "three.internal" })),
    ]);
    assert.equal(created.length, 3);
    assert.deepEqual(
      registry.list().map((host) => host.name),
      ["one", "three", "two"],
    );
    const payload = await readPayload();
    assert.equal(payload.hosts.length, 3);
  });
});

describe("host registry CRUD", () => {
  it("rejects duplicate names case-insensitively with HOST_EXISTS", async () => {
    const registry = makeRegistry();
    await registry.create(hostInput({ name: "prod" }));
    await rejectsWithCode(registry.create(hostInput({ name: "PROD" })), "HOST_EXISTS", /already exists/);
    assert.equal(registry.list().length, 1);
  });

  it("update replaces fields, keeps createdAt, bumps updatedAt and can rename", async () => {
    const registry = makeRegistry();
    const created = await registry.create(hostInput({ tags: ["old"], description: "before" }));

    const updated = await registry.update("prod-web-1", {
      name: "prod-web-2",
      host: "10.0.0.12",
      port: 2200,
      username: "deploy",
      tags: ["new"],
      description: "after",
    });
    assert.equal(updated.name, "prod-web-2");
    assert.equal(updated.host, "10.0.0.12");
    assert.equal(updated.port, 2200);
    assert.equal(updated.username, "deploy");
    assert.deepEqual(updated.tags, ["new"]);
    assert.equal(updated.description, "after");
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt >= created.createdAt);
    assert.equal(registry.get("prod-web-1"), undefined, "old name is gone after a rename");
    assert.deepEqual((await readPayload()).hosts.map((host) => host.name), ["prod-web-2"]);
  });

  it("update keeps the current name when input.name is omitted", async () => {
    const registry = makeRegistry();
    await registry.create(hostInput());
    const updated = await registry.update("prod-web-1", { host: "10.0.0.99" });
    assert.equal(updated.name, "prod-web-1");
    assert.equal(updated.host, "10.0.0.99");
  });

  it("update/delete report HOST_NOT_FOUND for unknown names", async () => {
    const registry = makeRegistry();
    await rejectsWithCode(registry.update("missing", hostInput({ name: "missing" })), "HOST_NOT_FOUND", /not found/);
    await rejectsWithCode(registry.delete("missing"), "HOST_NOT_FOUND", /not found/);
  });

  it("update rejects a rename onto another existing host with HOST_EXISTS", async () => {
    const registry = makeRegistry();
    await registry.create(hostInput({ name: "one" }));
    await registry.create(hostInput({ name: "two" }));
    await rejectsWithCode(
      registry.update("two", { name: "ONE", host: "10.0.0.2" }),
      "HOST_EXISTS",
      /already exists/,
    );
  });

  it("delete removes the host and returns true; the file reflects it", async () => {
    const registry = makeRegistry();
    await registry.create(hostInput({ name: "keep" }));
    await registry.create(hostInput({ name: "drop" }));

    assert.equal(await registry.delete("DROP"), true);
    assert.deepEqual((await readPayload()).hosts.map((host) => host.name), ["keep"]);
    await rejectsWithCode(registry.delete("drop"), "HOST_NOT_FOUND");
  });

  it("list/get return defensive copies", async () => {
    const registry = makeRegistry();
    await registry.create(hostInput({ name: "box", tags: ["a"] }));

    const listed = registry.list();
    listed[0].name = "mutated";
    listed[0].tags.push("b");
    assert.equal(registry.list()[0].name, "box");
    assert.deepEqual(registry.list()[0].tags, ["a"]);

    const got = registry.get("box");
    got.host = "mutated.internal";
    assert.equal(registry.get("box")?.host, "10.0.0.11");
    assert.equal(registry.get(""), undefined);
    assert.equal(registry.get("nope"), undefined);
  });

  it("keeps working after a rejected mutation and ensures load is idempotent", async () => {
    const registry = makeRegistry();
    await registry.load();
    await registry.load();
    assert.deepEqual(registry.list(), []);

    await registry.create(hostInput());
    await rejectsWithCode(registry.create(hostInput()), "HOST_EXISTS");
    const second = await registry.create(hostInput({ name: "other", host: "10.0.0.12" }));
    assert.equal(second.name, "other");
    assert.deepEqual(await registry.load(), registry.list(), "repeated load returns the same list");
    assert.equal(registry.list().length, 2);
  });
});

describe("host registry validation", () => {
  it("rejects raw secret fields with HOST_INVALID", async () => {
    for (const field of ["password", "passphrase", "secret", "token", "Password", "TOKEN"]) {
      const registry = makeRegistry();
      await rejectsWithCode(
        registry.create({ ...hostInput(), [field]: "hunter2" }),
        "HOST_INVALID",
        /raw secret field|environment-variable NAMES/,
      );
      await assert.rejects(stat(registryPath()), (error) => /** @type {any} */ (error).code === "ENOENT");
    }
  });

  it("rejects invalid names", async () => {
    const registry = makeRegistry();
    for (const name of ["", "has space", "slash/name", "ümlaut", "x".repeat(65), 42, null]) {
      await rejectsWithCode(registry.create(hostInput({ name })), "HOST_INVALID", /name/);
    }
  });

  it("accepts the documented valid edge cases", async () => {
    const registry = makeRegistry();
    const created = await registry.create({
      name: "A.b_c-1",
      host: "host.example.com",
      port: "2222",
      username: "deploy_user-1",
      passwordEnv: "_PW1",
      passphraseEnv: "KEY_PW",
      proxyJump: "bastion,admin@jump.example.com:2200",
      tags: "prod, web, web",
      description: "x".repeat(200),
    });
    assert.equal(created.port, 2222);
    assert.deepEqual(created.proxyJump, ["bastion", "admin@jump.example.com:2200"]);
    assert.deepEqual(created.tags, ["prod", "web"]);
    assert.equal(created.description.length, 200);
  });

  it("rejects invalid hosts, ports and usernames", async () => {
    const registry = makeRegistry();
    for (const host of [undefined, "", "has space", "tab\there", "x".repeat(256), 42]) {
      await rejectsWithCode(registry.create({ name: "box", host }), "HOST_INVALID", /host/);
    }
    for (const port of [0, 65_536, -1, 22.5, "abc", Number.NaN, true]) {
      await rejectsWithCode(registry.create(hostInput({ port })), "HOST_INVALID", /port/);
    }
    for (const username of ["bad name", "user@host", "x".repeat(65), 42]) {
      await rejectsWithCode(registry.create(hostInput({ username })), "HOST_INVALID", /username/);
    }
  });

  it("validates environment-variable NAMES, proxy jumps, tags and description", async () => {
    const registry = makeRegistry();
    for (const field of /** @type {const} */ (["passwordEnv", "passphraseEnv"])) {
      for (const value of ["1BAD", "bad-name", "has space", "with=equals", 123]) {
        await rejectsWithCode(registry.create(hostInput({ [field]: value })), "HOST_INVALID", new RegExp(field));
      }
    }

    for (const proxyJump of ["bad host", ["user@", "ok"], [42]]) {
      await rejectsWithCode(registry.create(hostInput({ proxyJump })), "HOST_INVALID", /proxyJump/);
    }
    await rejectsWithCode(registry.create(hostInput({ proxyJump: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })), "HOST_INVALID", /proxyJump/);

    await rejectsWithCode(
      registry.create(hostInput({ tags: Array.from({ length: 17 }, (_value, index) => `tag-${index}`) })),
      "HOST_INVALID",
      /tags/,
    );
    await rejectsWithCode(registry.create(hostInput({ tags: ["x".repeat(33)] })), "HOST_INVALID", /tag/);
    await rejectsWithCode(registry.create(hostInput({ tags: [42] })), "HOST_INVALID", /tags/);

    await rejectsWithCode(
      registry.create(hostInput({ description: "x".repeat(201) })),
      "HOST_INVALID",
      /description/,
    );
    await rejectsWithCode(registry.create(hostInput({ description: 42 })), "HOST_INVALID", /description/);
    await rejectsWithCode(registry.create(null), "HOST_INVALID", /object/);
    await rejectsWithCode(registry.create([]), "HOST_INVALID", /object/);
  });
});

describe("host registry corrupt/missing file tolerance", () => {
  /** @param {string} content */
  async function writeRegistry(content) {
    await mkdir(dirname(registryPath()), { recursive: true });
    await writeFile(registryPath(), content, "utf8");
  }

  it("warns and yields [] for a corrupt JSON file, then recovers on mutation", async () => {
    await writeRegistry("{not json");
    const logger = captureLogger();
    const registry = makeRegistry(logger);
    assert.deepEqual(await registry.load(), []);
    assert.deepEqual(registry.list(), []);
    assert.equal(logger.messages.length, 1);
    assert.match(logger.messages[0], /corrupt file/);

    const created = await registry.create(hostInput());
    assert.equal(created.name, "prod-web-1");
    assert.equal((await readPayload()).hosts.length, 1);
  });

  it("warns and yields [] for an unexpected JSON shape", async () => {
    for (const content of ["[]", "null", '{"version":1}', '{"version":1,"hosts":"nope"}', "   "]) {
      await writeRegistry(content);
      const logger = captureLogger();
      const registry = makeRegistry(logger);
      assert.deepEqual(await registry.load(), []);
      logger.messages.forEach((message) => assert.match(message, /host registry/));
      await rm(registryPath(), { force: true });
    }
  });

  it("skips invalid stored records but keeps the valid ones", async () => {
    await writeRegistry(
      JSON.stringify({
        version: 1,
        hosts: [
          { name: "good", host: "good.internal", port: 22, createdAt: 1, updatedAt: 2 },
          { name: "bad/name", host: "bad.internal" },
          { name: "no-host" },
          null,
          { name: "good", host: "duplicate.internal" },
          { name: "also-good", host: "also.internal", port: 22 },
        ],
      }),
    );
    const logger = captureLogger();
    const registry = makeRegistry(logger);
    const loaded = await registry.load();
    assert.deepEqual(loaded.map((host) => host.name), ["also-good", "good"]);
    assert.equal(loaded.find((host) => host.name === "good")?.host, "good.internal");
    assert.equal(logger.messages.length, 4, "three invalid + one duplicate warned");
  });

  it("strips hand-edited secret fields from stored records", async () => {
    await writeRegistry(
      JSON.stringify({
        version: 1,
        hosts: [
          { name: "box", host: "box.internal", password: "hunter2", token: "abc", createdAt: 1, updatedAt: 1 },
        ],
      }),
    );
    const registry = makeRegistry();
    const loaded = await registry.load();
    assert.equal(loaded.length, 1);
    assert.equal(JSON.stringify(loaded).includes("hunter2"), false);
    assert.equal(JSON.stringify(loaded).includes("abc"), false);
    assert.equal("password" in loaded[0], false);
  });
});

describe("createHostRegistry arguments", () => {
  it("requires a file path", () => {
    assert.throws(() => createHostRegistry(), /filePath/);
    assert.throws(() => createHostRegistry({ filePath: "   " }), /filePath/);
  });

  it("exposes the (tilde-expanded) registry filePath", () => {
    const registry = createHostRegistry({ filePath: registryPath() });
    assert.equal(registry.filePath, registryPath());
  });
});
