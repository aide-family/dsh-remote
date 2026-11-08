import { normalizeTargetChecks } from "./target-checks.js";
import { createPrivateRegistryFile, registryError } from "./private-registry.js";

function hostName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@+-]{1,256}$/.test(value)) throw registryError("Invalid exact logical host name.", "TARGET_HOST_INVALID");
  return value;
}
const clone = value => structuredClone(value);

/** Managed checks only. The controller must union these with static checks restrictively. */
export function createTargetRegistry({ root } = {}) {
  let cache = new Map();
  let cacheReady = false, cacheError = null;
  function validate(input) {
    if (!input || input.schema !== 1 || !Array.isArray(input.entries) || input.entries.length > 1000) throw registryError("Invalid or over-capacity target registry.", "REGISTRY_CAPACITY");
    const entries = input.entries.map(entry => {
      if (!entry || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || (entry.deleted !== undefined && typeof entry.deleted !== "boolean")) throw registryError("Invalid target revision.", "TARGET_REGISTRY_INVALID");
      return { host: hostName(entry.host), revision: entry.revision, checks: normalizeTargetChecks(entry.checks, "managed target checks"),
        ...(entry.deleted === true ? { deleted: true } : {}) };
    });
    if (new Set(entries.map(entry => entry.host)).size !== entries.length) throw registryError("Duplicate logical target entries.", "TARGET_REGISTRY_INVALID");
    return { schema: 1, entries };
  }
  const file = createPrivateRegistryFile({ root, filename: "targets.json", empty: () => ({ schema: 1, entries: [] }), validate });
  function remember(data) { cache = new Map(data.entries.map(entry => [entry.host, clone(entry)])); cacheReady = true; cacheError = null; }
  async function current() {
    try { return await file.read(); } catch (error) { cacheError = error; throw error; }
  }
  const view = (host, entry) => ({ host, revision: entry?.revision ?? 0, checks: clone(entry?.deleted ? [] : entry?.checks ?? []) });
  async function get(host) {
    hostName(host);
    const data = await current();
    remember(data);
    return view(host, cache.get(host));
  }
  async function write({ host, expectedRevision, checks }, deleted) {
    hostName(host);
    const normalized = normalizeTargetChecks(checks, "managed target checks");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw registryError("Expected target revision is required.", "TARGET_REVISION_CONFLICT");
    const result = await file.mutate(data => {
      const previous = data.entries.find(entry => entry.host === host);
      if ((previous?.revision ?? 0) !== expectedRevision) throw registryError("Target checks changed; reload before saving.", "TARGET_REVISION_CONFLICT");
      const entry = { host, revision: expectedRevision + 1, checks: normalized, ...(deleted ? { deleted: true } : {}) };
      if (previous) data.entries[data.entries.indexOf(previous)] = entry;
      else data.entries.push(entry);
      return entry;
    });
    // Reload after durable commit; never mark an unpersisted change as the current checked target.
    await get(host);
    return view(host, result);
  }
  return {
    get,
    save: request => write(request, false),
    remove: request => write({ ...request, checks: [] }, true),
    refresh: async host => {
      if (host !== undefined) return get(typeof host === "string" ? host : host.name);
      const data = await current(); remember(data); return { count: cache.size };
    },
    managedChecks: host => {
      if (cacheError) throw cacheError;
      if (!cacheReady) throw registryError("Managed target cache has not been refreshed; refuse unverified target selection.", "TARGET_CACHE_UNINITIALIZED");
      const name = hostName(typeof host === "string" ? host : host?.name);
      return view(name, cache.get(name)).checks;
    },
  };
}
