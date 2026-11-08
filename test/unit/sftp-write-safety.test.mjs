import assert from 'node:assert/strict';
import test from 'node:test';
import { statRemote, writeFileRemote } from '../../lib/ssh/sftp.js';

function fixture({ owner = { uid: 501, gid: 20 }, failRename = false, failChown = false, extension = false } = {}) {
  const calls = [];
  const error = () => Object.assign(new Error('fixture rejected operation'), { code: 3 });
  const sftp = {
    open(path, flags, mode, callback) { calls.push(['open', path, flags, mode]); callback(null, Buffer.from('handle')); },
    write(handle, chunk, offset, length, position, callback) { calls.push(['write', position, length]); callback(null); },
    close(handle, callback) { calls.push(['close']); callback(null); },
    lstat(path, callback) { calls.push(['lstat', path]); callback(null, { mode: 0o100600, size: 3, mtime: 1, ...owner }); },
    chown(path, uid, gid, callback) { calls.push(['chown', path, uid, gid]); callback(failChown ? error() : null); },
    chmod(path, mode, callback) { calls.push(['chmod', path, mode]); callback(null); },
    rename(from, to, callback) { calls.push(['rename', from, to]); callback(failRename ? error() : null); },
    unlink(path, callback) { calls.push(['unlink', path]); callback(null); },
  };
  if (extension) sftp.ext_openssh_rename = (from, to, callback) => { calls.push(['posix-rename', from, to]); callback(null); };
  return { sftp, calls };
}

test('SFTP stat preserves owner and group with lstat semantics', async () => {
  const { sftp } = fixture();
  const value = await statRemote(sftp, '/etc/demo.conf');
  assert.equal(value.uid, 501);
  assert.equal(value.gid, 20);
  assert.equal(value.type, 'file');
});

test('atomic write uses private exclusive temporary file, owner then mode before rename', async () => {
  const { sftp, calls } = fixture();
  const result = await writeFileRemote(sftp, '/etc/demo.conf', 'new', { mode: 0o640, uid: 502, gid: 21 });
  assert.equal(result.bytesWritten, 3);
  assert.equal(calls[0][2], 'wx');
  assert.equal(calls[0][3], 0o600);
  assert.ok(calls.findIndex(c => c[0] === 'chown') < calls.findIndex(c => c[0] === 'chmod'));
  assert.ok(calls.findIndex(c => c[0] === 'chmod') < calls.findIndex(c => c[0] === 'rename'));
  assert.deepEqual(calls.find(c => c[0] === 'chown').slice(2), [502, 21]);
  assert.equal(calls.find(c => c[0] === 'chmod')[2], 0o640);
  assert.equal(calls.some(c => c[0] === 'unlink'), false);
});

test('new files default to private mode rather than bypassing umask with 0666', async () => {
  const { sftp, calls } = fixture();
  await writeFileRemote(sftp, '/etc/demo.conf', 'new');
  assert.equal(calls.find(c => c[0] === 'chmod')[2], 0o600);
});

test('matching temporary ownership does not require chown privilege', async () => {
  const { sftp, calls } = fixture({ failChown: true });
  await writeFileRemote(sftp, '/etc/demo.conf', 'new', { mode: 0o600, uid: 501, gid: 20 });
  assert.equal(calls.some(c => c[0] === 'chown'), false);
});

test('ownership failure leaves destination untouched and only cleans temporary file', async () => {
  const { sftp, calls } = fixture({ failChown: true });
  await assert.rejects(writeFileRemote(sftp, '/etc/demo.conf', 'new', { mode: 0o640, uid: 502, gid: 21 }));
  assert.equal(calls.some(c => c[0] === 'rename'), false);
  assert.equal(calls.some(c => c[0] === 'unlink' && c[1] === '/etc/demo.conf'), false);
  assert.equal(calls.filter(c => c[0] === 'unlink').length, 1);
});

test('rename refusal never falls back to unlinking the original', async () => {
  const { sftp, calls } = fixture({ failRename: true });
  await assert.rejects(writeFileRemote(sftp, '/etc/demo.conf', 'new', { mode: 0o600 }));
  assert.equal(calls.filter(c => c[0] === 'rename').length, 1);
  assert.equal(calls.some(c => c[0] === 'unlink' && c[1] === '/etc/demo.conf'), false);
});

test('OpenSSH atomic rename extension is supported without destination deletion', async () => {
  const { sftp, calls } = fixture({ failRename: true, extension: true });
  await writeFileRemote(sftp, '/etc/demo.conf', 'new', { mode: 0o600 });
  assert.equal(calls.filter(c => c[0] === 'posix-rename').length, 1);
  assert.equal(calls.some(c => c[0] === 'unlink'), false);
});

test('aborted write never attempts mutation', async () => {
  const { sftp, calls } = fixture();
  await assert.rejects(writeFileRemote(sftp, '/etc/demo.conf', 'new', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
