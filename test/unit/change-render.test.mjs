import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderers, formatEdit, formatWrite } from '../../lib/render.js';

const change = { host: 'fixture', path: '/etc/demo.conf', bytesWritten: 3, backupId: 'backup-fixture', beforeVersion: 'v-before', afterVersion: 'v-after' };

test('write and edit render recoverable backup and version facts without file content', () => {
  for (const rendered of [formatWrite(change), formatEdit({ ...change, replacements: 1 })]) {
    assert.match(rendered, /Backup ID: backup-fixture/);
    assert.match(rendered, /Before version: v-before/);
    assert.match(rendered, /After version: v-after/);
    assert.match(rendered, /remote_restore requires approval/);
  }
});

test('restore has a registered renderer and reports verification without claiming reload', () => {
  const render = createRenderers().remote_restore;
  assert.equal(typeof render, 'function');
  const rendered = render({}, { ...change, verification: { status: 'passed', exitCode: 0, timedOut: false } })[0].text;
  assert.match(rendered, /^Restored fixture:\/etc\/demo.conf/);
  assert.match(rendered, /Verification: passed; exit code: 0/);
  assert.doesNotMatch(rendered, /reload(ed)? successfully/i);
});

test('failed or uncertain verification rendering says to stop and inspect', () => {
  for (const status of ['failed', 'timed_out', 'unknown', 'cancelled']) {
    const rendered = formatWrite({ ...change, verification: { status, exitCode: null, timedOut: status === 'timed_out' } });
    assert.match(rendered, /Do not reload or retry automatically/);
    assert.match(rendered, /exit code: unknown/);
  }
});
