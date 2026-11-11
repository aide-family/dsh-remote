import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("../../lib/terminal/bridge.cjs", import.meta.url), "utf8");
const require = createRequire(import.meta.url);

function bridgeHarness() {
  const timers = new Map(), sockets = [], logs = [], output = [], modes = [];
  let nextTimer = 0, exitCode;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode(value) { modes.push(value); }, setEncoding() {}, resume() {},
  });
  const stdout = Object.assign(new EventEmitter(), { isTTY: false, write(text) { output.push(String(text)); } });
  const process = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr: stdout, env: {}, argv: ["node", "bridge.cjs", "--host", "entry-root-demo", "--session", "missing", "--socket", "/tmp/test-bridge.sock"],
    version: "v24.0.0", execPath: "/node", pid: 1,
    exit(code) { exitCode = code; },
  });
  const net = { connect() {
    const socket = Object.assign(new EventEmitter(), { writable: true, writes: [], write(text) { this.writes.push(String(text)); }, end() { this.emit('close'); }, destroy() { this.emit('close'); } });
    sockets.push(socket);
    return socket;
  } };
  const fs = { mkdirSync() {}, appendFileSync(_path, text) { logs.push(text); }, statSync() { return { isFile: () => true, size: 0 }; } };
  vm.runInNewContext(source, {
    require(name) { return name === "node:net" ? net : name === "node:fs" ? fs : require(name); },
    process, Buffer, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    process, sockets, logs, output, modes,
    get exitCode() { return exitCode; },
    tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); return timer.delay; },
  };
}

function handshakeReply(socket, fields) {
  const request = JSON.parse(socket.writes[0]);
  return Buffer.from('\u001eDSHREMOTE/1 ' + JSON.stringify({ v: 1, nonce: request.nonce, ...fields }) + '\n');
}

test('confirmed missing session stops immediately without another reconnect', () => {
  const h = bridgeHarness();
  const socket = h.sockets[0];
  socket.emit('connect');
  socket.emit('data', handshakeReply(socket, { status: 'rejected', code: 'SESSION_GONE', retryable: false }));
  assert.equal(h.tick(), 100);
  assert.equal(h.exitCode, 1);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.modes, [true, false]);
  assert.ok(h.output.join('').includes('已停止重连'));
});

test('fragmented acceptance strips only the prelude and forwards coalesced raw output', () => {
  const h = bridgeHarness(), socket = h.sockets[0];
  socket.emit('connect');
  h.process.stdin.emit('data', 'unconfirmed-input');
  const reply = handshakeReply(socket, { status: 'accepted' });
  socket.emit('data', reply.subarray(0, 8));
  socket.emit('data', Buffer.concat([reply.subarray(8), Buffer.from('hello-shell')]));
  h.process.stdin.emit('data', 'hostname\r');
  const inputs = socket.writes.map(text => JSON.parse(text)).filter(frame => frame.t === 'i');
  assert.equal(inputs.length, 1);
  assert.equal(Buffer.from(inputs[0].d, 'base64').toString(), 'hostname\r');
  assert.ok(h.output.join('').includes('hello-shell'));
  assert.equal(h.output.join('').includes('DSHREMOTE/1'), false);
  const marker = '\u001eDSHREMOTE/1 this-is-ordinary-PTY-output';
  socket.emit('data', Buffer.from(marker));
  assert.ok(h.output.join('').includes(marker), 'post-accept output is never parsed as control');
});

test('retryable lookup failure retries rather than claiming the session is gone', () => {
  const h = bridgeHarness(), socket = h.sockets[0];
  socket.emit('connect');
  socket.emit('data', handshakeReply(socket, { status: 'rejected', code: 'LOOKUP_UNAVAILABLE', retryable: true }));
  assert.equal(h.tick(), 1000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.exitCode, undefined);
});

test('wrong nonce cannot trigger permanent session-closed handling', () => {
  const h = bridgeHarness(), socket = h.sockets[0];
  socket.emit('connect');
  socket.emit('data', Buffer.from('\u001eDSHREMOTE/1 ' + JSON.stringify({ v: 1, nonce: 'wrong', status: 'rejected', code: 'SESSION_GONE', retryable: false }) + '\n'));
  socket.emit('close');
  assert.equal(h.tick(), 1000);
  assert.equal(h.exitCode, undefined);
});

test("bridge bounds reconnects when TCP connects but the session repeatedly rejects attach", () => {
  const h = bridgeHarness();
  for (let attempt = 0; attempt <= 120; attempt += 1) {
    const socket = h.sockets.at(-1);
    socket.emit("connect");
    // Even rejection output is not proof that the session was accepted.
    socket.emit("data", Buffer.from("session missing"));
    socket.emit("close");
    assert.equal(h.tick(), attempt < 120 ? 1000 : 100);
  }
  assert.equal(h.sockets.length, 121);
  assert.equal(h.exitCode, 1);
  assert.ok(h.logs.some((line) => line.includes("reconnect attempt=120/120")));
  assert.ok(h.logs.some((line) => line.includes("exhausted after 120")));
  assert.deepEqual(h.modes, [true, false]);
});

test("bridge retries transport loss and SIGTERM cancels pending retry and restores tty", () => {
  const h = bridgeHarness();
  h.sockets[0].emit("connect");
  h.sockets[0].emit("data", Buffer.from("shell output"));
  h.sockets[0].emit("close");
  assert.equal(h.tick(), 1000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit("close");
  h.process.emit("SIGTERM");
  assert.equal(h.tick(), 100);
  assert.equal(h.exitCode, 0);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.modes, [true, false]);
});
