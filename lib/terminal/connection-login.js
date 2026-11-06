import { createApprovalGate } from "../approval.js";
import { normalizeConnectionProfile, TERMINAL_ACTION_KEYS } from "../connection-profile.js";
import { createScrollback, createSanitizerState, sanitizeChunk } from "./scrollback.js";

const authorization = new WeakMap();
const MAX_SEQUENCE_MS = 20 * 60_000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const isSend = (action) => ["command", "text", "key"].includes(action.type);
const stepErrors = new WeakSet();
function stepFailure(error, index, actions) {
  if (stepErrors.has(error)) return error;
  const reason = ({ LOGIN_TIMEOUT: "Timed out waiting for completion", LOGIN_CANCELLED: "Cancelled",
    LOGIN_EXIT: "SSH PTY exited", LOGIN_DENIED: "Denied by the connection action policy" })[error?.code] ?? "Execution failed";
  const wrapped = new Error(`Connection action ${index + 1}/${actions.length} (${actions[index].type}): ${reason}`, { cause: error });
  if (error?.code !== undefined) wrapped.code = error.code;
  stepErrors.add(wrapped);
  return wrapped;
}

/** Configured initialization sends are operator-trusted, not Agent tool calls.
 * Keep static hard denials, but never request Agent approval for saved actions.
 */
async function authorizeActions(profile, { host = profile, config = {}, hosts, logger } = {}) {
  if (!profile.actions?.some(isSend)) return;
  const gate = createApprovalGate({ config, logger });
  let pending = "", uncertain = false;
  for (const [index, action] of profile.actions.entries()) {
    if (!isSend(action)) continue;
    let subject;
    if (action.type === "text") { pending += action.value; subject = pending; }
    else if (action.type === "command") { subject = pending + action.value; pending = ""; }
    else if (action.value === "Enter") { subject = pending || "terminal Enter"; pending = ""; }
    else { subject = pending || `terminal ${action.value}`; uncertain = true; }
    const risk = gate.assessCommand(subject);
    if (risk.denied) throw stepFailure(failure("LOGIN_DENIED", "Connection action denied by denyCommandPatterns"), index, profile.actions);
    // Editing/history/completion is unproven, never a read-only exemption.
    // Operator trust does not override an entrance's read-only restriction.
    const readonly = hosts?.isReadonly?.(host) === true || host.readonly === true;
    const unproven = uncertain || risk.level === "gray" || action.type !== "command";
    if (readonly && (risk.level === "high" || unproven)) {
      throw stepFailure(failure("LOGIN_DENIED", "Connection action denied because the host is read-only"), index, profile.actions);
    }
  }
}
export async function authorizeConnectionLogin(host, options = {}) {
  const profile = normalizeConnectionProfile(host);
  if (!profile.actions) return null;
  const context = { ...options, host };
  await authorizeActions(profile, context);
  authorization.set(profile, context);
  return profile;
}
function promptPredicate(targetCluster) {
  const cluster = targetCluster?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = cluster
    ? new RegExp(`(?:^|\\[)root@[^\\s:@]+\\.${cluster}(?:\\.[^\\s:@]+)*[ :][^\\n]*#\\s*$`)
    // Some K8s-backed terminals prefix PS1 with a mode label (e.g. K8S-RONLY).
    // Keep a user@host prompt mandatory; a banner/status label alone is not ready.
    : /^(?:\[[^\]\n@]{1,80}\][ \t]*)?(?:\[[^\]\n@]+@[^\n]+\]|[^\s\n@]+@[^\n]+)[#$][ \t]*$/;
  return (text) => {
    const tail = text.split("\n").at(-1);
    // A mode label changes presentation, not the required target hostname.
    const prompt = targetCluster ? tail.replace(/^\[[^\]\n@]{1,80}\][ \t]*/, "") : tail;
    return expected.test(prompt);
  };
}
/** Subscribe continuously, including synchronous output inside write(). */
function createOutputMonitor(pty, { initialOutput = "", signal } = {}) {
  const newRing = () => createScrollback({ maxLines: 100, maxBytes: 32_768 });
  let ring = newRing();
  const sanitizer = createSanitizerState();
  ring.append(sanitizeChunk(sanitizer, initialOutput));
  let terminalError, waiter;
  let offData = () => {}, offExit = () => {};
  const check = () => {
    if (!waiter) return;
    if (terminalError) waiter.finish(terminalError);
    else if (waiter.predicate(ring.snapshot({ count: 100 }).text)) waiter.finish();
  };
  const fail = (error) => { terminalError ??= error; check(); };
  const onAbort = () => fail(failure("LOGIN_CANCELLED", "Connection actions cancelled"));
  offData = pty.onData((chunk) => { ring.append(sanitizeChunk(sanitizer, chunk)); check(); });
  offExit = pty.onExit(() => fail(failure("LOGIN_EXIT", "SSH PTY exited during connection actions")));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (pty.status?.().kind === "exited") fail(failure("LOGIN_EXIT", "SSH PTY exited during connection actions"));
  return {
    reset() { ring = newRing(); },
    consume(literal) {
      const text = ring.snapshot({ count: 100 }).text;
      const end = text.indexOf(literal) + literal.length;
      ring = newRing();
      ring.append(text.slice(end));
    },
    check() { if (terminalError) throw terminalError; },
    wait(predicate, timeoutMs, timeoutMessage = "Timed out waiting for connection action completion", delay = false) {
      return new Promise((resolve, reject) => {
        let settled = false, timer;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiter = undefined;
          if (error) reject(error); else resolve();
        };
        waiter = { predicate, finish };
        timer = setTimeout(() => finish(delay ? undefined : failure("LOGIN_TIMEOUT", timeoutMessage)), timeoutMs);
        check();
      });
    },
    dispose() { offData(); offExit(); signal?.removeEventListener("abort", onAbort); },
  };
}
/** Compatibility helper: wait for an actual prompt, never silence. */
export async function waitForLoginPrompt(pty, { initialOutput = "", targetCluster, timeoutMs = 30_000, signal } = {}) {
  const monitor = createOutputMonitor(pty, { initialOutput, signal });
  try { await monitor.wait(promptPredicate(targetCluster), timeoutMs, targetCluster
    ? `Timed out waiting for the root prompt on cluster ${targetCluster}; cluster login is not confirmed`
    : "Timed out waiting for the entry host shell prompt; login command was not sent");
  } finally { monitor.dispose(); }
}
/** Run once per genuinely new PTY; its owner controls mounting and reattach. */
export async function runConnectionLogin(pty, { profile, initialOutput, signal, timeoutMs = 30_000, onCommand, onProgress } = {}) {
  if (!profile) return;
  const normalized = normalizeConnectionProfile(profile);
  if (!normalized.actions) return;
  const actions = normalized.actions;
  let index = 0, completed = 0, startedStep = false;
  const publish = (state) => {
    const action = state === "running" ? actions[index] : undefined;
    const progress = { state, total: actions.length, index, completed,
      ...(action ? { type: action.type, ...(action.label ? { label: action.label } : {}) } : {}) };
    try { onProgress?.(progress); } catch { /* Observers cannot change execution. */ }
  };
  const monitor = createOutputMonitor(pty, { initialOutput, signal });
  const deadline = Date.now() + MAX_SEQUENCE_MS;
  const boundedTimeout = (duration) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("LOGIN_TIMEOUT", "Connection action sequence exceeded 20 minutes");
    return Math.min(duration, remaining);
  };
  try {
    publish("waiting-entry");
    monitor.check();
    // Revalidate so mutation of an authorized profile never inherits authority.
    await authorizeActions(normalized, authorization.get(profile) ?? { host: profile });
    monitor.check();
    // A first literal wait explicitly selects menu readiness after SSH auth.
    if (actions[0].type !== "wait") {
      await monitor.wait(promptPredicate(), boundedTimeout(timeoutMs), "Timed out waiting for the entry host shell prompt; login command was not sent");
      monitor.reset();
    }
    for (index = 0; index < actions.length; index += 1) {
      startedStep = true;
      monitor.check();
      const action = actions[index];
      publish("running");
      monitor.check();
      const stepTimeout = boundedTimeout(action.timeoutMs ?? 30_000);
      if (action.type === "delay") {
        const duration = boundedTimeout(action.durationMs);
        if (duration < action.durationMs) await monitor.wait(() => false, duration);
        else await monitor.wait(() => false, duration, undefined, true);
      } else if (action.type === "wait") {
        await monitor.wait((text) => text.includes(action.value), stepTimeout);
        monitor.consume(action.value);
      } else {
        if (action.type === "command" || action.expect !== undefined) monitor.reset();
        if (action.type === "command") onCommand?.(action.value);
        monitor.check();
        pty.write(action.type === "command" ? `${action.value}\r` : action.type === "text" ? action.value : TERMINAL_ACTION_KEYS[action.value]);
        monitor.check();
        const predicate = action.expect !== undefined ? (text) => text.includes(action.expect)
          : action.type === "command" ? promptPredicate(action.expectCluster) : undefined;
        if (predicate) {
          await monitor.wait(predicate, stepTimeout);
          if (action.expect !== undefined) monitor.consume(action.expect);
          else monitor.reset();
        }
      }
      monitor.check();
      boundedTimeout(1);
      completed += 1;
    }
    publish("completed");
  } catch (error) {
    publish(error?.code === "LOGIN_CANCELLED" ? "cancelled" : "failed");
    throw startedStep && index < actions.length ? stepFailure(error, index, actions) : error;
  } finally { monitor.dispose(); }
}
