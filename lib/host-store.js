/**
 * dsh-remote host store.
 *
 * Resolves the current host list from the managed-host registry, ~/.ssh/config
 * and the plugin configuration, with a short cache so a burst of tool calls in
 * one turn does not re-read the files each time. `refresh: true` bypasses the
 * cache (the `remote_hosts` tool exposes it for the model after a user edits
 * the config); `invalidate()` drops the cache so the next `list()` reloads
 * (the management API calls it after a registry mutation).
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
 * @param {{
 *   load: () => Promise<unknown[]>,
 *   list: () => unknown[],
 * }} [options.registry] Managed-host registry (`lib/host-registry.js`); optional.
 * @param {typeof loadHosts} [options.load] Injection seam for tests.
 * @returns {{
 *   list: (options?: { refresh?: boolean }) => Promise<import("./hosts.js").RemoteHost[]>,
 *   find: (query: string) => Promise<import("./hosts.js").RemoteHost>,
 *   isAllowed: (host: import("./hosts.js").RemoteHost) => boolean,
 *   isReadonly: (host: import("./hosts.js").RemoteHost) => boolean,
 *   fingerprint: () => Promise<string>,
 *   invalidate: () => void,
 *   config: object,
 * }}
 */
export function createHostStore({ config, logger, registry, load = loadHosts }) {
  let cachedHosts = [];
  let cachedAt = 0;
  /** @type {Promise<import("./hosts.js").RemoteHost[]> | undefined} */
  let inflight;
  /** Cache generation; `invalidate()` bumps it so an in-flight load cannot repopulate stale data. */
  let generation = 0;

  /**
   * Load the registry (best effort) and hand its records to `loadHosts`.
   *
   * @returns {Promise<import("./hosts.js").RemoteHost[]>}
   */
  async function loadOnce() {
    /** @type {unknown[] | undefined} */
    let registryHosts;
    if (registry !== undefined && registry !== null) {
      try {
        await registry.load();
      } catch (error) {
        logger?.warn?.(
          `dsh-remote: managed host registry load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        const records = registry.list();
        registryHosts = Array.isArray(records) ? records : [];
      } catch (error) {
        logger?.warn?.(
          `dsh-remote: managed host registry listing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      return await load(config, { registryHosts, logger });
    } catch (error) {
      logger?.warn?.(`dsh-remote: host discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async function list({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && cachedAt !== 0 && now - cachedAt < CACHE_TTL_MS) return cachedHosts;
    if (inflight === undefined) {
      const startedGeneration = generation;
      const pending = loadOnce()
        .then((hosts) => {
          if (startedGeneration === generation) {
            cachedHosts = hosts;
            cachedAt = Date.now();
          }
          return hosts;
        })
        .finally(() => {
          if (inflight === pending) inflight = undefined;
        });
      inflight = pending;
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

  /** Drop the cache; the next `list()` reloads registry + config + ssh config. */
  function invalidate() {
    generation += 1;
    cachedHosts = [];
    cachedAt = 0;
    inflight = undefined;
  }

  return { list, find, isAllowed, isReadonly, fingerprint, invalidate, config };
}
