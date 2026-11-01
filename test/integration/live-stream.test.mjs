/**
 * Live SSE endpoint tests: real HTTP server, real hub, fenced with the Host
 * connection stand-in, streaming frames parsed as they arrive.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createLiveHub } from "../../lib/live.js";
import { LIVE_PATH, createLiveStreamHandler } from "../../lib/live-stream.js";

function fakeCtx({ fence = true } = {}) {
  return {
    get(name) {
      if (name !== "connection") return undefined;
      if (!fence) return undefined;
      return {
        requestRejection(req) {
          return req.headers["x-deny-test"] === "1" ? 403 : undefined;
        },
      };
    },
  };
}

async function startStream({ fence = true, hub } = {}) {
  const liveHub = hub ?? createLiveHub();
  const handler = createLiveStreamHandler({ ctx: fakeCtx({ fence }), hub: liveHub });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    hub: liveHub,
    url: `http://127.0.0.1:${port}${LIVE_PATH}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Open the stream and return a frame reader. */
async function openStream(api, { headers = {} } = {}) {
  const controller = new AbortController();
  const response = await fetch(api.url, { headers, signal: controller.signal });
  return { response, controller };
}

/** Read SSE `data:` frames until `count` frames arrived or the deadline passes. */
async function readFrames(response, count, timeoutMs = 3_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} frames (got ${frames.length})`);
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("read timeout")), remaining)),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

test("streams the replay snapshot, then live start/output/end frames", async () => {
  const api = await startStream();
  try {
    const prior = api.hub.begin({ sessionId: "s0", tool: "remote_exec", host: "me", command: "uptime", kind: "exec" });
    prior.output("stdout", "old output\n");
    prior.end({ code: 0, durationMs: 3 });

    const { response, controller } = await openStream(api);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);

    // Publish live events after the snapshot is on the wire.
    const command = api.hub.begin({ sessionId: "s1", tool: "remote_exec", host: "me", command: "echo live", kind: "exec" });
    command.output("stdout", "live output\n");
    command.end({ code: 0, durationMs: 7 });

    const frames = await readFrames(response, 4);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["snapshot", "start", "output", "end"],
    );
    assert.equal(frames[0].commands[0].command, "uptime");
    assert.equal(frames[0].commands[0].output, "old output\n");
    assert.equal(frames[1].command, "echo live");
    assert.deepEqual(frames[2], { type: "output", id: command.id, stream: "stdout", text: "live output\n" });
    assert.equal(frames[3].code, 0);
    controller.abort();
  } finally {
    await api.close();
  }
});

test("unsubscribes when the client disconnects", async () => {
  const hub = createLiveHub();
  const api = await startStream({ hub });
  const { controller } = await openStream(api);
  assert.equal(hub.subscriberCount, 1);
  controller.abort();
  // The server observes the closed socket asynchronously.
  const deadline = Date.now() + 2_000;
  while (hub.subscriberCount !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(hub.subscriberCount, 0);
  await api.close();
});

test("rejections and protocol errors are structured", async () => {
  const api = await startStream();
  try {
    const forbidden = await fetch(api.url, { headers: { "x-deny-test": "1" } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, "FORBIDDEN");

    const post = await fetch(api.url, { method: "POST" });
    assert.equal(post.status, 405);

    const wrongPath = await fetch(api.url.replace(LIVE_PATH, `${LIVE_PATH}/extra`));
    assert.equal(wrongPath.status, 404);
    assert.equal((await wrongPath.json()).error.code, "NOT_FOUND");
  } finally {
    await api.close();
  }
});

test("a missing connection fence fails closed", async () => {
  const api = await startStream({ fence: false });
  try {
    const response = await fetch(api.url);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "FENCE_UNAVAILABLE");
  } finally {
    await api.close();
  }
});

test("clear frames reach a connected terminal", async () => {
  const api = await startStream();
  try {
    api.hub.begin({ tool: "remote_exec", host: "me", command: "x" });
    const { response, controller } = await openStream(api);
    // snapshot first, then clear
    api.hub.clear();
    const frames = await readFrames(response, 2);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["snapshot", "clear"],
    );
    controller.abort();
  } finally {
    await api.close();
  }
});
