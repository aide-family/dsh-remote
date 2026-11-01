/**
 * Unit tests for dsh-remote host discovery and configuration:
 *   - lib/ssh-config.js   (OpenSSH client config parser)
 *   - lib/hosts.js        (merge, resolution, allow/readonly globs)
 *   - lib/config.js       (Schemastery Config + normalizeConfig validation)
 *
 * Run with: node --test test/unit/hosts.test.mjs
 *
 * Fixtures are real files in a per-run temp directory so Include handling,
 * `~` expansion and missing-file tolerance are exercised exactly as in
 * production; nothing outside the temp dir is read or written.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Config, normalizeConfig } from "../../lib/config.js";
import { findHost, isHostAllowed, isHostReadonly, loadHosts } from "../../lib/hosts.js";
import { loadSshConfig, splitConfigLine } from "../../lib/ssh-config.js";

/** @type {string} */
let root;
/** @type {number} */
let caseCounter = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-remote-hosts-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Create a fresh fixture directory for one test case.
 *
 * @param {string} label
 * @returns {string}
 */
function makeCase(label) {
  caseCounter += 1;
  const dir = join(root, `${String(caseCounter).padStart(2, "0")}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a fixture file, creating parent directories.
 *
 * @param {string} dir Base directory.
 * @param {string} relativePath Path relative to `dir`.
 * @param {string} content
 * @returns {string} Absolute path of the written file.
 */
function fixture(dir, relativePath, content) {
  const path = join(dir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** @param {Record<string, unknown>} hosts @param {string} name */
function hostNamed(hosts, name) {
  const host = hosts.find((entry) => entry.name === name);
  assert.ok(host !== undefined, `expected host ${JSON.stringify(name)} in ${JSON.stringify(hosts.map((h) => h.name))}`);
  return host;
}

// ---------------------------------------------------------------------------
// lib/ssh-config.js
// ---------------------------------------------------------------------------

describe("loadSshConfig", () => {
  it("parses Host blocks, multiple aliases, keywords, comments and quoting", () => {
    const dir = makeCase("parser-basic");
    const configPath = fixture(
      dir,
      "config",
      `# leading comment
Host web1 web2
    HostName 10.0.0.10
    User ops
    Port 2222
    IdentityFile "~/.ssh/my key#1"
    ProxyJump bastion.example.com,admin@jump.example.com:2200
    # a comment inside the block

Host db-prod
    hostname db.internal   # trailing comment
    user dba
    PORT 22

Host *.example.com web?
    User pattern-user

Host web1
    HostName ignored-second-definition.example.com

Host negated
    HostName negated.internal

Host !neg real *.internal
    HostName real.internal
`,
    );

    const hosts = loadSshConfig(configPath, { homeDir: dir });

    // Sorted by name; patterns skipped; first Host alias definition wins.
    assert.deepEqual(
      hosts.map((host) => host.name),
      ["db-prod", "negated", "real", "web1", "web2"],
    );

    const web1 = hostNamed(hosts, "web1");
    assert.equal(web1.host, "10.0.0.10", "first Host block for an alias wins");
    assert.equal(web1.port, 2222);
    assert.equal(web1.username, "ops");
    assert.equal(web1.identityFile, "~/.ssh/my key#1");
    assert.deepEqual(web1.proxyJump, ["bastion.example.com", "admin@jump.example.com:2200"]);

    const db = hostNamed(hosts, "db-prod");
    assert.equal(db.host, "db.internal");
    assert.equal(db.username, "dba");
    assert.equal(db.port, 22, "case-insensitive key PORT is honored");
    assert.equal(db.identityFile, undefined);

    assert.equal(hostNamed(hosts, "negated").host, "negated.internal");
    assert.equal(hostNamed(hosts, "real").host, "real.internal");
  });

  it("falls back to the alias when HostName is absent and ignores stray global options", () => {
    const dir = makeCase("parser-fallback");
    const configPath = fixture(
      dir,
      "config",
      `HostName global.example.com
User global-user

Host alias-only
    User bob

Host empty-hostname
    HostName ""

Host hostname-forms
    HostName=eq.example.com
`,
    );

    const hosts = loadSshConfig(configPath);
    assert.equal(hostNamed(hosts, "alias-only").host, "alias-only");
    assert.equal(hostNamed(hosts, "alias-only").username, "bob");
    assert.equal(hostNamed(hosts, "empty-hostname").host, "empty-hostname");
    assert.equal(hostNamed(hosts, "hostname-forms").host, "eq.example.com");
  });

  it("follows Include: globs, relative paths, absolute paths and quoting", () => {
    const dir = makeCase("parser-include");
    const absolutePath = fixture(dir, "outside/abs.conf", "Host absolute-host\n  HostName abs.internal\n");

    fixture(
      dir,
      "config.d/10-first.conf",
      `Host first-included
  HostName first.internal
`,
    );
    fixture(
      dir,
      "config.d/20-second.conf",
      `Host second-included
  HostName second.internal
`,
    );
    fixture(dir, "extra.conf", "Host rel-included\n  HostName rel.internal\n");
    fixture(dir, "config dir/space path.conf", "Host space-included\n  HostName space.internal\n");

    const configPath = fixture(
      dir,
      "config",
      `Include config.d/*
Include "config dir/space path.conf"
Host main
  HostName main.internal
Include extra.conf
Include ${absolutePath}
`,
    );

    const hosts = loadSshConfig(configPath);
    assert.deepEqual(
      hosts.map((host) => host.name),
      [
        "absolute-host",
        "first-included",
        "main",
        "rel-included",
        "second-included",
        "space-included",
      ],
    );
    assert.equal(hostNamed(hosts, "main").host, "main.internal");
    assert.equal(hostNamed(hosts, "first-included").host, "first.internal");
    assert.equal(hostNamed(hosts, "space-included").host, "space.internal");
  });

  it("resolves `~` in Include paths against the provided homeDir", () => {
    const home = makeCase("parser-home");
    fixture(home, "extra/home-extra.conf", "Host home-included\n  HostName home.internal\n");
    const configPath = fixture(
      home,
      ".ssh/config",
      `Include ~/extra/*.conf
Host local
  HostName local.internal
`,
    );

    const hosts = loadSshConfig(configPath, { homeDir: home });
    assert.deepEqual(hosts.map((host) => host.name), ["home-included", "local"]);
    assert.equal(hostNamed(hosts, "home-included").host, "home.internal");
  });

  it("gives included bare options to the enclosing Host block (textual inclusion)", () => {
    const dir = makeCase("parser-inline-include");
    fixture(dir, "inline-user.conf", "User included-user\nPort 2022\n");
    const configPath = fixture(
      dir,
      "config",
      `Host inline
  HostName inline.internal
  Include inline-user.conf

Host after
  HostName after.internal
`,
    );

    const hosts = loadSshConfig(configPath);
    const inline = hostNamed(hosts, "inline");
    assert.equal(inline.host, "inline.internal");
    assert.equal(inline.username, "included-user");
    assert.equal(inline.port, 2022);
    assert.equal(hostNamed(hosts, "after").host, "after.internal");
  });

  it("guards against deep include chains", () => {
    const dir = makeCase("parser-depth");
    for (let index = 0; index < 20; index += 1) {
      const next = index + 1 < 20 ? `Include chain-${index + 1}.conf\n` : "";
      fixture(
        dir,
        `chain-${index}.conf`,
        `Host chain-${index}\n  HostName chain-${index}.internal\n${next}`,
      );
    }

    const hosts = loadSshConfig(join(dir, "chain-0.conf"));
    assert.ok(hostNamed(hosts, "chain-0") !== undefined, "the primary file is always parsed");
    assert.ok(
      hosts.length < 20,
      `depth guard should stop before the end of the chain, got ${hosts.length} hosts`,
    );
    assert.equal(
      hosts.some((host) => host.name === "chain-19"),
      false,
      "the deepest chain entries must not be reached",
    );
  });

  it("breaks include cycles without hanging or throwing", () => {
    const dir = makeCase("parser-cycle");
    fixture(dir, "a.conf", "Host cycle-a\n  HostName a.internal\nInclude b.conf\n");
    fixture(dir, "b.conf", "Host cycle-b\n  HostName b.internal\nInclude a.conf\n");

    const hosts = loadSshConfig(join(dir, "a.conf"));
    assert.deepEqual(hosts.map((host) => host.name), ["cycle-a", "cycle-b"]);
  });

  it("returns [] for missing, unreadable, empty and garbage files without throwing", () => {
    const dir = makeCase("parser-lenient");

    assert.deepEqual(loadSshConfig(join(dir, "missing")), []);
    assert.deepEqual(loadSshConfig(""), []);
    assert.deepEqual(loadSshConfig(join(dir, "missing"), { homeDir: dir }), []);

    const empty = fixture(dir, "empty", "# nothing but comments\n\n   \n");
    assert.deepEqual(loadSshConfig(empty), []);

    const garbage = fixture(
      dir,
      "garbage",
      `Host
  ??? 
  "unterminated
HostName
Port not-a-port
Match all
  User nobody
`,
    );
    assert.deepEqual(loadSshConfig(garbage), []);
    assert.deepEqual(loadSshConfig(dir), [], "a directory path is tolerated");
  });

  it("skips unreadable include targets but keeps the rest of the config", () => {
    const dir = makeCase("parser-unreadable");
    const secret = fixture(dir, "secret.conf", "Host secret\n  HostName secret.internal\n");
    chmodSync(secret, 0o000);
    try {
      const configPath = fixture(
        dir,
        "config",
        `Include secret.conf
Host visible
  HostName visible.internal
`,
      );
      const hosts = loadSshConfig(configPath);
      assert.deepEqual(
        hosts.map((host) => host.name),
        ["visible"],
      );
    } finally {
      chmodSync(secret, 0o600);
    }
  });

  it("splitConfigLine keeps quoted spaces and hashes and drops trailing comments", () => {
    assert.deepEqual(splitConfigLine('IdentityFile "~/.ssh/my key#1" # note'), [
      "IdentityFile",
      "~/.ssh/my key#1",
    ]);
    assert.deepEqual(splitConfigLine("  Host   a\tb  "), ["Host", "a", "b"]);
    assert.deepEqual(splitConfigLine("HostName quoted.example.com"), ["HostName", "quoted.example.com"]);
    assert.deepEqual(splitConfigLine("   # whole line comment"), []);
    assert.deepEqual(splitConfigLine(""), []);
  });
});

// ---------------------------------------------------------------------------
// lib/hosts.js
// ---------------------------------------------------------------------------

/**
 * Build the standard merge fixture: one ssh config file plus configured hosts.
 *
 * @returns {{ dir: string, sshConfigPath: string, rawConfig: Record<string, unknown> }}
 */
function mergeFixture() {
  const dir = makeCase("merge");
  const sshConfigPath = fixture(
    dir,
    "ssh-config",
    `Host shared
  HostName ssh-shared.internal

Host ssh-only
  HostName ssh-only.internal
  Port 2200

Host overridden
  HostName ssh-overridden.internal
`,
  );

  return {
    dir,
    sshConfigPath,
    rawConfig: {
      hosts: [
        {
          name: "overridden",
          host: "10.0.0.99",
          username: "ops",
          identityFile: "~/.ssh/prod_ed25519",
          passwordEnv: "PROD_PASSWORD",
          passphraseEnv: "PROD_PASSPHRASE",
          proxyJump: ["bastion.example.com"],
          tags: ["prod", "web"],
          description: "primary web node",
        },
        { name: "cfg-only", host: "10.0.0.50" },
      ],
      sshConfigPath,
    },
  };
}

describe("loadHosts", () => {
  it("merges ssh-config and configured hosts, config winning on name collisions", async () => {
    const { sshConfigPath, rawConfig } = mergeFixture();
    const hosts = await loadHosts(rawConfig);

    assert.deepEqual(
      hosts.map((host) => host.name),
      ["cfg-only", "overridden", "shared", "ssh-only"],
      "hosts are deduped and sorted by name",
    );

    const overridden = hostNamed(hosts, "overridden");
    assert.equal(overridden.id, "config:overridden");
    assert.equal(overridden.source, "config");
    assert.equal(overridden.host, "10.0.0.99");
    assert.equal(overridden.port, 22, "configured hosts default to port 22");
    assert.equal(overridden.username, "ops");
    assert.equal(overridden.identityFile, "~/.ssh/prod_ed25519");
    assert.equal(overridden.passwordEnv, "PROD_PASSWORD", "only the env NAME is carried");
    assert.equal(overridden.passphraseEnv, "PROD_PASSPHRASE");
    assert.deepEqual(overridden.proxyJump, ["bastion.example.com"]);
    assert.deepEqual(overridden.tags, ["prod", "web"]);
    assert.equal(overridden.description, "primary web node");

    const shared = hostNamed(hosts, "shared");
    assert.equal(shared.id, "ssh-config:shared");
    assert.equal(shared.source, "ssh-config");
    assert.equal(shared.host, "ssh-shared.internal");
    assert.equal(shared.port, 22);
    assert.equal(shared.passwordEnv, undefined, "ssh-config hosts never carry auth references");
    assert.equal(shared.passphraseEnv, undefined);

    const sshOnly = hostNamed(hosts, "ssh-only");
    assert.equal(sshOnly.id, "ssh-config:ssh-only");
    assert.equal(sshOnly.port, 2200);
  });

  it("honors includeSshConfig: false and tolerates a missing ssh config", async () => {
    const { sshConfigPath, rawConfig } = mergeFixture();

    const withoutSsh = await loadHosts({ ...rawConfig, includeSshConfig: false });
    assert.deepEqual(withoutSsh.map((host) => host.name), ["cfg-only", "overridden"]);
    assert.equal(withoutSsh.some((host) => host.source === "ssh-config"), false);

    const missing = await loadHosts({ sshConfigPath: join(dirname(sshConfigPath), "nope"), hosts: [] });
    assert.deepEqual(missing, []);
  });

  it("expands `~` in sshConfigPath and resolves includes against that homeDir", async () => {
    const home = makeCase("hosts-home");
    fixture(home, ".ssh/extra.conf", "Host home-extra\n  HostName extra.internal\n");
    fixture(
      home,
      ".ssh/config",
      `Include extra.conf
Host from-home
  HostName home.internal
`,
    );

    const hosts = await loadHosts({ includeSshConfig: true }, { homeDir: home });
    assert.deepEqual(
      hosts.map((host) => host.name),
      ["from-home", "home-extra"],
    );
    assert.equal(hostNamed(hosts, "from-home").host, "home.internal");
    assert.equal(hostNamed(hosts, "home-extra").host, "extra.internal");
  });

  it("never throws on a malformed ssh config and still returns configured hosts", async () => {
    const dir = makeCase("hosts-bad-ssh-config");
    const sshConfigPath = fixture(
      dir,
      "config",
      'Host\n  HostName\n  "unterminated\nPort nope\nInclude missing.conf\n',
    );
    const hosts = await loadHosts({ sshConfigPath, hosts: [{ name: "cfg", host: "10.0.0.7" }] });
    assert.deepEqual(hosts.map((host) => host.name), ["cfg"]);
  });

  it("throws a clear Error naming a malformed configured host", async () => {
    await assert.rejects(
      loadHosts({ includeSshConfig: false, hosts: [{ name: "broken-port", host: "10.0.0.1", port: 70000 }] }),
      /broken-port/,
    );
    await assert.rejects(
      loadHosts({ includeSshConfig: false, hosts: [{ name: "missing-host" }] }),
      /missing-host/,
    );
    await assert.rejects(
      loadHosts({ includeSshConfig: false, hosts: [{ name: "secret-typo", host: "10.0.0.1", passwordEnv: 123 }] }),
      /secret-typo/,
    );
  });

  it("keeps disallowed hosts in the list and flags readonly hosts", async () => {
    const { rawConfig } = mergeFixture();
    const hosts = await loadHosts({
      ...rawConfig,
      allowHosts: ["shared", "cfg-*"],
      readonlyHosts: ["SSH-*", "overridden"],
    });

    // allowHosts is enforced by isHostAllowed (tools), not by dropping hosts.
    assert.equal(hosts.length, 4);
    const allowed = hosts.filter((host) => isHostAllowed(host, { allowHosts: ["shared", "cfg-*"] }));
    assert.deepEqual(allowed.map((host) => host.name), ["cfg-only", "shared"]);

    for (const host of hosts) {
      const expected = host.name === "ssh-only" || host.name === "overridden";
      assert.equal(isHostReadonly(host, { readonlyHosts: ["SSH-*", "overridden"] }), expected, host.name);
      if (expected) assert.equal(host.readonly, true);
      else assert.equal(host.readonly, undefined);
    }
  });
});

describe("findHost", () => {
  it("resolves by name, by id, case-insensitively, and returns undefined when unknown", async () => {
    const { rawConfig } = mergeFixture();
    const hosts = await loadHosts(rawConfig);

    assert.equal(findHost(hosts, "shared")?.id, "ssh-config:shared");
    assert.equal(findHost(hosts, "config:cfg-only")?.host, "10.0.0.50");
    assert.equal(findHost(hosts, "ssh-config:ssh-only")?.port, 2200);
    assert.equal(findHost(hosts, "SHARED")?.id, "ssh-config:shared");
    assert.equal(findHost(hosts, "  cfg-only  ")?.id, "config:cfg-only");
    assert.equal(findHost(hosts, "overridden")?.source, "config", "config hosts win on name collisions");

    assert.equal(findHost(hosts, "missing"), undefined);
    assert.equal(findHost(hosts, ""), undefined);
    assert.equal(findHost([], "shared"), undefined);
  });
});

describe("isHostAllowed / isHostReadonly globs", () => {
  /** @param {string} name @returns {import("../../lib/hosts.js").RemoteHost} */
  const host = (name) => ({ id: `config:${name}`, name, host: "10.0.0.1", port: 22, source: "config" });

  it("treats an empty or missing allow list as allow-everything", () => {
    assert.equal(isHostAllowed(host("prod-web-1"), {}), true);
    assert.equal(isHostAllowed(host("prod-web-1"), { allowHosts: [] }), true);
  });

  it("matches * and ? case-insensitively against the host name", () => {
    assert.equal(isHostAllowed(host("prod-web-1"), { allowHosts: ["prod-*"] }), true);
    assert.equal(isHostAllowed(host("PROD-WEB-1"), { allowHosts: ["prod-*"] }), true);
    assert.equal(isHostAllowed(host("staging-web-1"), { allowHosts: ["prod-*"] }), false);
    assert.equal(isHostAllowed(host("web1"), { allowHosts: ["web?"] }), true);
    assert.equal(isHostAllowed(host("web10"), { allowHosts: ["web?"] }), false);
    assert.equal(isHostAllowed(host("db-1"), { allowHosts: ["db-1"] }), true);
    assert.equal(isHostAllowed(host("db-10"), { allowHosts: ["db-1"] }), false);
  });

  it("treats non-glob regexp characters literally", () => {
    assert.equal(isHostAllowed(host("a.b"), { allowHosts: ["a.b"] }), true);
    assert.equal(isHostAllowed(host("axb"), { allowHosts: ["a.b"] }), false, "'.' is literal");
    assert.equal(isHostAllowed(host("a+b"), { allowHosts: ["a+b"] }), true);
  });

  it("requires a name and ignores malformed patterns", () => {
    assert.equal(isHostAllowed({ id: "config:x", host: "10.0.0.1" }, { allowHosts: ["*"] }), false);
    assert.equal(isHostAllowed(host("web1"), { allowHosts: [42, "", "web?"] }), true);
  });

  it("flags readonly hosts from globs or the loaded readonly flag", () => {
    assert.equal(isHostReadonly(host("db-1"), { readonlyHosts: ["DB-*"] }), true);
    assert.equal(isHostReadonly(host("db-1"), { readonlyHosts: [] }), false);
    assert.equal(isHostReadonly(host("db-1"), {}), false);
    assert.equal(isHostReadonly({ ...host("db-1"), readonly: true }, {}), true);
    assert.equal(isHostReadonly({ ...host("web-1"), readonly: false }, { readonlyHosts: ["web-*"] }), true);
  });
});

// ---------------------------------------------------------------------------
// lib/config.js
// ---------------------------------------------------------------------------

describe("Config schema", () => {
  it("fills exactly the documented defaults with no config", () => {
    const expected = {
      hosts: [],
      includeSshConfig: true,
      sshConfigPath: "~/.ssh/config",
      policy: "auto",
      readonlyHosts: [],
      allowHosts: [],
      denyCommandPatterns: [],
      connectTimeoutMs: 20_000,
      execTimeoutMs: 120_000,
      maxOutputBytes: 200_000,
      maxReadBytes: 800_000,
      maxTransferBytes: 52_428_800,
      knownHostsPolicy: "tofu",
      allowLocalOutsideWorkspace: false,
      promptGuidance: true,
      terminalEnabled: true,
      managementApi: true,
      unprovenCommands: "allow",
      liveTerminal: true,
      autoOpenLiveTerminal: true,
      devLiveEvents: false,
      terminalRows: 40,
      terminalCols: 120,
      terminalIdleSilenceMs: 800,
      terminalTimeoutMs: 30_000,
      terminalStartupTimeoutMs: 15_000,
      terminalScrollbackLines: 2_000,
      terminalScrollbackBytes: 2_000_000,
      terminalMaxReadBytes: 262_144,
    };
    assert.deepEqual(Config(), expected);
    assert.deepEqual(normalizeConfig({}), expected);
    assert.deepEqual(normalizeConfig(undefined), expected);
    assert.deepEqual(normalizeConfig(null), expected);
  });

  it("accepts the documented host fields", () => {
    const parsed = Config({
      hosts: [
        {
          name: "prod-web-1",
          host: "10.0.0.11",
          port: 22,
          passwordEnv: "PROD_WEB_PASSWORD",
          passphraseEnv: "PROD_KEY_PASSPHRASE",
          identityFile: "~/.ssh/prod_ed25519",
          tags: ["prod", "web"],
        },
      ],
      policy: "never",
      knownHostsPolicy: "strict",
    });
    assert.equal(parsed.hosts[0].passwordEnv, "PROD_WEB_PASSWORD");
    assert.equal(parsed.policy, "never");
    assert.equal(parsed.knownHostsPolicy, "strict");
  });

  it("rejects invalid values through Schemastery", () => {
    assert.throws(() => Config({ policy: "sometimes" }), /policy/);
    assert.throws(() => Config({ hosts: [{ name: "a" }] }), /host/);
    assert.throws(() => Config({ hosts: [{ name: "a", host: "b", port: 70000 }] }), /port/);
    assert.throws(() => Config({ hosts: [{ name: "a", host: "b", passwordEnv: 123 }] }), /passwordEnv/);
  });
});

describe("normalizeConfig", () => {
  it("returns a defaults-filled plain object and is idempotent", () => {
    const normalized = normalizeConfig({});
    assert.deepEqual(normalizeConfig(normalized), normalized);

    const full = normalizeConfig({
      includeSshConfig: false,
      sshConfigPath: "/tmp/ssh-config",
      policy: "always",
      readonlyHosts: ["db-*"],
      allowHosts: ["prod-*"],
      denyCommandPatterns: ["^rm -rf"],
      connectTimeoutMs: 1_000,
      execTimeoutMs: 2_000,
      maxOutputBytes: 3_000,
      maxReadBytes: 4_000,
      maxTransferBytes: 5_000,
      knownHostsPolicy: "insecure",
      allowLocalOutsideWorkspace: true,
      promptGuidance: false,
      hosts: [
        {
          name: "  prod-web-1  ",
          host: "  10.0.0.11  ",
          username: " ops ",
          identityFile: " ~/.ssh/prod ",
          passwordEnv: " PROD_WEB_PASSWORD ",
          passphraseEnv: "PROD_KEY_PASSPHRASE",
          proxyJump: [" bastion.example.com "],
          tags: [" prod "],
          description: " primary ",
        },
      ],
    });

    assert.equal(full.includeSshConfig, false);
    assert.equal(full.policy, "always");
    assert.equal(full.knownHostsPolicy, "insecure");
    assert.deepEqual(full.readonlyHosts, ["db-*"]);
    assert.deepEqual(full.allowHosts, ["prod-*"]);
    assert.deepEqual(full.denyCommandPatterns, ["^rm -rf"]);
    assert.equal(full.connectTimeoutMs, 1_000);
    assert.equal(full.allowLocalOutsideWorkspace, true);
    assert.equal(full.promptGuidance, false);

    assert.deepEqual(full.hosts, [
      {
        name: "prod-web-1",
        host: "10.0.0.11",
        port: 22,
        username: "ops",
        identityFile: "~/.ssh/prod",
        passwordEnv: "PROD_WEB_PASSWORD",
        passphraseEnv: "PROD_KEY_PASSPHRASE",
        proxyJump: ["bastion.example.com"],
        tags: ["prod"],
        description: "primary",
      },
    ]);
    assert.deepEqual(normalizeConfig(full), full, "idempotent for a normalized config");
  });

  it("leaves denyCommandPatterns regexp compilation to the approval gate", () => {
    // Invalid RegExp sources are skipped with a warning by lib/approval.js; config
    // normalization must not turn them into a plugin-load failure.
    assert.deepEqual(normalizeConfig({ denyCommandPatterns: ["(", "^rm -rf"] }).denyCommandPatterns, [
      "(",
      "^rm -rf",
    ]);
  });

  it("ignores unknown top-level keys instead of polluting the normalized object", () => {
    assert.deepEqual(normalizeConfig({ bogus: true, hosts: [] }), normalizeConfig({}));
  });

  it("rejects duplicate host names case-insensitively", () => {
    assert.throws(
      () =>
        normalizeConfig({
          hosts: [
            { name: "prod", host: "10.0.0.1" },
            { name: "Prod", host: "10.0.0.2" },
          ],
        }),
      /duplicate host name "Prod"/,
    );
  });

  it("rejects invalid ports and non-host-shaped entries", () => {
    for (const port of [0, 65_536, -1, 22.5, "22", Number.NaN]) {
      assert.throws(
        () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", port }] }),
        /host "web": port/,
        `port ${String(port)} must be rejected`,
      );
    }
    assert.throws(() => normalizeConfig({ hosts: [{ host: "10.0.0.1" }] }), /hosts\[0\]: name/);
    assert.throws(() => normalizeConfig({ hosts: [{ name: "web" }] }), /host "web": host/);
    assert.throws(() => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", port: 70000 }] }), /web/);
    assert.throws(() => normalizeConfig({ hosts: "nope" }), /hosts must be an array/);
    assert.throws(() => normalizeConfig({ hosts: [null] }), /hosts\[0\] must be an object/);
    assert.throws(() => normalizeConfig({ hosts: [{ name: "has space", host: "x" }] }), /whitespace/);
    assert.throws(() => normalizeConfig({ hosts: [{ name: "a", host: "has space" }] }), /whitespace/);
  });

  it("requires passwordEnv/passphraseEnv to be environment-variable NAMES", () => {
    for (const invalid of [123, 0, true, "", "1BAD", "bad-name", "has space", "with=equals"]) {
      assert.throws(
        () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", passwordEnv: invalid }] }),
        /passwordEnv must be the NAME of an environment variable/,
        `passwordEnv ${JSON.stringify(invalid)} must be rejected`,
      );
      assert.throws(
        () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", passphraseEnv: invalid }] }),
        /passphraseEnv must be the NAME of an environment variable/,
      );
    }

    for (const valid of ["A", "_x1", "PROD_PASSWORD"]) {
      const normalized = normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", passwordEnv: valid }] });
      assert.equal(normalized.hosts[0].passwordEnv, valid);
    }
  });

  it("validates proxyJump, tags, globs and numeric ranges", () => {
    assert.throws(
      () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", proxyJump: "bastion" }] }),
      /proxyJump must be an array/,
    );
    assert.throws(
      () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", proxyJump: [""] }] }),
      /proxyJump\[0\]/,
    );
    assert.throws(
      () => normalizeConfig({ hosts: [{ name: "web", host: "10.0.0.1", tags: "prod" }] }),
      /tags must be an array/,
    );
    assert.throws(() => normalizeConfig({ allowHosts: "prod-*" }), /allowHosts must be an array/);
    assert.throws(() => normalizeConfig({ allowHosts: ["prod-*", ""] }), /allowHosts\[1\]/);
    assert.throws(() => normalizeConfig({ readonlyHosts: [42] }), /readonlyHosts\[0\]/);
    assert.throws(() => normalizeConfig({ denyCommandPatterns: [null] }), /denyCommandPatterns\[0\]/);

    for (const field of [
      "connectTimeoutMs",
      "execTimeoutMs",
      "maxOutputBytes",
      "maxReadBytes",
      "maxTransferBytes",
    ]) {
      for (const value of [0, -5, 1.5, "100"]) {
        assert.throws(
          () => normalizeConfig({ [field]: value }),
          new RegExp(`${field} must be a positive integer`),
          `${field}=${String(value)} must be rejected`,
        );
      }
    }

    assert.throws(() => normalizeConfig({ sshConfigPath: "" }), /sshConfigPath/);
    assert.throws(() => normalizeConfig({ includeSshConfig: "yes" }), /includeSshConfig must be a boolean/);
    assert.throws(() => normalizeConfig({ policy: "sometimes" }), /policy must be one of/);
    assert.throws(() => normalizeConfig({ knownHostsPolicy: "maybe" }), /knownHostsPolicy must be one of/);
    assert.throws(() => normalizeConfig("nope"), /config must be an object/);
    assert.throws(() => normalizeConfig([1]), /config must be an object/);
  });
});
