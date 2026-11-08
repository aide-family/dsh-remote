import { createHash } from 'node:crypto';
import { hostBinding } from './file-change.js';

/** Identity of the actual SSH/shortcut route, independent of any workflow engine. */
export function connectionBinding(host) {
  const tuple = JSON.parse(hostBinding(host));
  return JSON.stringify([...tuple, host.viaHost ?? null, host.actions ?? []]);
}
export const targetConnectionDigest = host => createHash('sha256').update(connectionBinding(host)).digest('hex');
export const targetChecksDigest = checks => createHash('sha256').update(JSON.stringify(checks)).digest('hex');
