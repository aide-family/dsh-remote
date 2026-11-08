import { normalizeTargetChecks, composeTargetChecks } from './target-checks.js';
const fail = (message, code) => Object.assign(new Error(message), { code });
const METHODS = new Set(['target.get', 'target.save', 'target.delete']);

/** Operator target configuration only; saving never executes a remote probe. */
export function createTargetApi({ targetRegistry, targets, hosts }) {
  const handles = method => METHODS.has(method);
  async function host(name) {
    if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f]/u.test(name) || Buffer.byteLength(name) > 256) throw fail('Invalid logical host.', 'TARGET_HOST_INVALID');
    const value = await hosts.find(name);
    if (!value || !hosts.isAllowed(value)) throw fail('Logical host is unavailable or denied.', 'HOST_NOT_ALLOWED');
    return value;
  }
  function revision(value) { if (!Number.isSafeInteger(value) || value < 0) throw fail('A current expectedRevision is required.', 'TARGET_INVALID_REVISION'); return value; }
  function configured(value) {
    const checks = targets.configuredChecksFor?.(value);
    if (!Array.isArray(checks)) throw fail('Configured target metadata is unavailable.', 'TARGET_METADATA_UNAVAILABLE');
    return checks;
  }
  async function view(value) {
    const saved = await targetRegistry.get(value.name);
    return { host: value.name, revision: saved.revision, checks: structuredClone(saved.checks),
      configuredChecks: structuredClone(configured(value)), effectiveChecks: structuredClone(targets.checksFor(value)) };
  }
  async function dispatch(body, signal) {
    if (!body || !handles(body.method)) throw fail('Unknown target management method.', 'UNKNOWN_METHOD');
    signal?.throwIfAborted();
    await targetRegistry.refresh();
    const value = await host(body.host);
    if (body.method === 'target.save') {
      if (!Array.isArray(body.checks)) throw fail('An explicit target check array is required.', 'TARGET_CHECK_INVALID');
      const checks = normalizeTargetChecks(body.checks);
      composeTargetChecks([configured(value), checks]);
      await targetRegistry.save({ host: value.name, expectedRevision: revision(body.expectedRevision), checks });
    } else if (body.method === 'target.delete') {
      configured(value);
      await targetRegistry.remove({ host: value.name, expectedRevision: revision(body.expectedRevision) });
    }
    return view(value);
  }
  return { handles, dispatch };
}
