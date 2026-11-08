/** Pure, restrictive host/tag safety profiles. No network or runtime peers. */
import { normalizeTargetChecks, composeTargetChecks } from "./target-checks.js";
const POLICIES = ["auto", "always", "never"];
const UNPROVEN = ["allow", "ask"];
const MAX_PROFILES = 100;
const error = (message) => new Error(`dsh-remote config: ${message}`);

function strings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 1024)) {
    throw error(`${label} must be an array of at most 100 non-empty strings (max 1024 characters each)`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}
function text(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw error(`${label} must be a non-empty string (max 1024 characters)`);
  return value.trim();
}

export function normalizeSafetyProfiles(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROFILES) throw error(`profiles must be an array of at most ${MAX_PROFILES} entries`);
  const seen = new Set();
  return value.map((input, index) => {
    const label = `profiles[${index}]`;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw error(`${label} must be an object`);
    const name = text(input.name, `${label}.name`);
    if (!name) throw error(`${label}.name is required`);
    if (seen.has(name)) throw error(`${label}.name must be unique`);
    seen.add(name);
    const hosts = strings(input.hosts, `${label}.hosts`);
    const tags = strings(input.tags, `${label}.tags`);
    if (!hosts.length && !tags.length) throw error(`${label} needs at least one hosts or tags selector`);
    const environment = text(input.environment, `${label}.environment`);
    const impact = text(input.impact, `${label}.impact`);
    for (const [key, choices] of [["policy", POLICIES], ["unprovenCommands", UNPROVEN]]) {
      if (input[key] !== undefined && !choices.includes(input[key])) throw error(`${label}.${key} must be one of ${choices.join(", ")}`);
    }
    if (input.readonly !== undefined && typeof input.readonly !== "boolean") throw error(`${label}.readonly must be boolean`);
    const denyCommandPatterns = strings(input.denyCommandPatterns, `${label}.denyCommandPatterns`);
    for (const pattern of denyCommandPatterns) {
      try { new RegExp(pattern); } catch { throw error(`${label}.denyCommandPatterns contains an invalid regular expression`); }
    }
    return {
      name, hosts, tags, denyCommandPatterns,
      targetChecks: normalizeTargetChecks(input.targetChecks, `${label}.targetChecks`),
      ...(environment ? { environment } : {}), ...(impact ? { impact } : {}),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      ...(input.readonly === undefined ? {} : { readonly: input.readonly }),
      ...(input.unprovenCommands === undefined ? {} : { unprovenCommands: input.unprovenCommands }),
    };
  });
}

/** Literal except * and ?, case-insensitive like existing host-name globs. */
function matchesGlob(name, glob) {
  const source = [...glob].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("");
  return new RegExp(`^${source}$`, "i").test(name);
}

export function resolveSafetyProfile(config = {}, host = {}) {
  // Shortcut aliases inherit entrance-name restrictions. Tags are only trusted
  // host metadata (not terminal output); callers may include entrance tags here.
  const names = [host.name, ...(host.connectionPolicyNames ?? [])].filter((name) => typeof name === "string");
  const tags = new Set([...(host.tags ?? []), ...(host.connectionPolicyTags ?? [])]);
  const profiles = (config.profiles ?? []).filter((profile) =>
    profile.hosts?.some((glob) => names.some((name) => matchesGlob(name, glob))) || profile.tags?.some((tag) => tags.has(tag)));
  const policies = [config.policy ?? "auto", ...profiles.map((profile) => profile.policy).filter(Boolean)];
  const policy = policies.includes("never") ? "never" : policies.includes("always") ? "always" : "auto";
  const environments = [...new Set(profiles.map((profile) => profile.environment).filter(Boolean))];
  const production = environments.some((value) => /^(prod|production)$/i.test(value));
  return {
    policy,
    readonly: host.readonly === true || (config.readonlyHosts ?? []).some((glob) => names.some((name) => matchesGlob(name, glob))) || profiles.some((profile) => profile.readonly === true),
    unprovenCommands: production || config.unprovenCommands === "ask" || profiles.some((profile) => profile.unprovenCommands === "ask") ? "ask" : "allow",
    denyCommandPatterns: [...new Set([...(config.denyCommandPatterns ?? []), ...profiles.flatMap((profile) => profile.denyCommandPatterns ?? [])])],
    profiles: profiles.map((profile) => profile.name),
    environments,
    impacts: [...new Set(profiles.map((profile) => profile.impact).filter(Boolean))],
    // Entrance safety restrictions are inherited, but entrance identity checks
    // would run in the logical cluster's shell and attest the wrong target.
    targetChecks: composeTargetChecks((config.profiles ?? []).filter(profile =>
      profile.hosts?.some(glob => typeof host.name === "string" && matchesGlob(host.name, glob)) ||
      profile.tags?.some(tag => (host.tags ?? []).includes(tag))).map(profile => profile.targetChecks)),
  };
}
