/**
 * dsh-remote host store.
 *
 * Resolves the current host list from ~/.ssh/config plus the plugin
 * configuration, with a short cache so a burst of tool calls in one turn does
 * not re-read the file each time. `refresh: true` bypasses the cache (the
 * `remote_hosts` tool exposes it for the model after a user edits the config).
 *
 * The store is also the place where policy-facing host flags are resolved:
 * `isAllowed` / `isReadonly` come from the hosts module and use the same config
 * snapshot, so every tool sees one consistent view.
 */

import { createHash } from "node:crypto";

import { loadHosts, findHost, isHostAllowed, isHostReadonly } from "./hosts.js";

const CACHE_TTL_MS = 10_000;

/**
 * @param {object} options
 * @param {object} options.config Normalized plugin config.
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @param {typeof loadHosts} [options.load] Injection seam for tests.
 * @returns {{
 *   list: (options?: { refresh?: boolean }) => Promise<import("./hosts.js").RemoteHost[]>,
 *   find: (query: string) => Promise<import("./hosts.js").RemoteHost>,
 *   isAllowed: (host: import("./hosts.js").RemoteHost) => boolean,
 *   isReadonly: (host: import("./hosts.js").RemoteHost) => boolean,
 *   fingerprint: () => Promise<string>,
 *   config: object,
 * }}
 */
export function createHostStore({ config, logger, load = loadHosts }) {
  let cachedHosts = [];
  let cachedAt = 0;
  /** @type {Promise<import("./hosts.js").RemoteHost[]> | undefined} */
  let inflight;

  async function loadOnce() {
    try {
      return await load(config);
    } catch (error) {
      logger?.warn?.(`dsh-remote: host discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async function list({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && cachedAt !== 0 && now - cachedAt < CACHE_TTL_MS) return cachedHosts;
    if (inflight === undefined) {
      inflight = loadOnce()
        .then((hosts) => {
          cachedHosts = hosts;
          cachedAt = Date.now();
          return hosts;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  }

  async function find(query) {
    const hosts = await list();
    const host = findHost(hosts, query);
    if (host !== undefined) return host;
    const names = hosts.map((item) => item.name).slice(0, 20);
    const hint = names.length > 0 ? `Available hosts: ${names.join(", ")}${hosts.length > names.length ? ", …" : ""}.` : "No hosts are configured.";
    const error = new Error(`Unknown remote host ${JSON.stringify(String(query ?? ""))}. ${hint} Call remote_hosts to list hosts.`);
    error.code = "UNKNOWN_HOST";
    throw error;
  }

  function isAllowed(host) {
    return isHostAllowed(host, config);
  }

  function isReadonly(host) {
    return isHostReadonly(host, config);
  }

  /** Stable hash of the resolved host identity for transfer/cache keys. */
  async function fingerprint() {
    const hosts = await list();
    return createHash("sha1")
      .update(hosts.map((host) => `${host.id}|${host.host}|${host.port ?? 22}|${host.username ?? ""}`).join("\n"))
      .digest("hex");
  }

  return { list, find, isAllowed, isReadonly, fingerprint, config };
}
