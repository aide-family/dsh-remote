/** Pure validation for terminal-only connection action profiles. */
const LOOKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LOGIN_RE = /^ *sww +-r +-u +([A-Za-z0-9][A-Za-z0-9._-]{0,63}) +([A-Za-z0-9][A-Za-z0-9._-]{0,63}) *$/u;
export const TERMINAL_ACTION_KEYS = Object.freeze({
  Enter: "\r", Tab: "\t", Escape: "\x1b", "Ctrl-C": "\x03", "Ctrl-D": "\x04",
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowLeft: "\x1b[D", ArrowRight: "\x1b[C", Backspace: "\x7f",
});
const FIELDS = {
  command: ["type", "label", "value", "expect", "expectCluster", "timeoutMs"],
  text: ["type", "label", "value", "expect", "timeoutMs"],
  key: ["type", "label", "value", "expect", "timeoutMs"],
  wait: ["type", "label", "value", "timeoutMs"],
  delay: ["type", "label", "durationMs"],
};

/** Normalize and deep-copy actions. Never interpret user-supplied regular expressions. */
export function normalizeTerminalActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 32) throw invalid("actions must contain 1-32 items");
  return Array.from(actions).map((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action) || !Object.hasOwn(FIELDS, action.type)) throw invalid(`actions[${index}] has an invalid type`);
    const allowed = FIELDS[action.type];
    for (const field of Object.keys(action)) if (!allowed.includes(field)) throw invalid(`actions[${index}] has an unsupported field`);
    const result = { type: action.type };
    if (action.label !== undefined) result.label = boundedText(action.label, 80, /[\x00-\x1f\x7f]/u, "action label");
    if (action.type === "delay") {
      result.durationMs = boundedInteger(action.durationMs, 0, 120_000, "durationMs");
      return result;
    }
    if (action.type === "key") {
      if (typeof action.value !== "string" || !Object.hasOwn(TERMINAL_ACTION_KEYS, action.value)) throw invalid("unsupported action key");
      result.value = action.value;
    } else result.value = boundedText(action.value, action.type === "wait" ? 2048 : 4096, action.type === "wait" ? /[\x00\x1b]/u : /[\x00-\x1f\x7f]/u, "action value");
    if (action.expect !== undefined) result.expect = boundedText(action.expect, 2048, /[\x00\x1b]/u, "action expect");
    if (action.expectCluster !== undefined) {
      if (action.expect !== undefined || typeof action.expectCluster !== "string" || !LOOKUP_NAME_RE.test(action.expectCluster) || /\s/u.test(action.expectCluster)) throw invalid("expectCluster must be a safe cluster name and cannot be combined with expect");
      result.expectCluster = action.expectCluster;
    }
    if (action.timeoutMs !== undefined) result.timeoutMs = boundedInteger(action.timeoutMs, 100, 120_000, "timeoutMs");
    return result;
  });
}

/** Host metadata may accompany the profile; only connection fields are returned. */
export function normalizeConnectionProfile(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid("connection profile must be an object");
  const { viaHost, loginCommand, actions } = input;
  if (viaHost === undefined && loginCommand === undefined && actions === undefined) return {};
  if (typeof viaHost !== "string" || /\s/u.test(viaHost) || !LOOKUP_NAME_RE.test(viaHost)) throw invalid("viaHost must be a safe host lookup name (1-64 ASCII characters)");
  if (actions !== undefined) return { viaHost, actions: normalizeTerminalActions(actions) };
  if (typeof loginCommand !== "string" || /[\x00-\x1f\x7f]/u.test(loginCommand)) throw invalid("loginCommand must be a single-line sww -r -u <user> <cluster> command");
  const match = LOGIN_RE.exec(loginCommand);
  if (!match) throw invalid("loginCommand only supports sww -r -u <safe-user> <safe-cluster>");
  return { viaHost, actions: [{ type: "command", value: `sww -r -u ${match[1]} ${match[2]}`, expectCluster: match[2] }] };
}
function boundedText(value, max, controls, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || controls.test(value)) throw invalid(`${name} must contain 1-${max} valid characters`);
  return value;
}
function boundedInteger(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function invalid(message) {
  return Object.assign(new Error(`dsh-remote: ${message}`), { code: "HOST_INVALID" });
}
