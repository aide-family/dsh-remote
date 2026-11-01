/**
 * SSE transport for the live terminal mirror.
 *
 * `GET /dsh-remote/live` streams the live hub's commands to the browser half.
 * The route is fenced exactly like the management API: the Host connection
 * service applies its Host/Origin + browser-cookie checks, and a missing fence
 * fails closed. The first frame is the replay snapshot, then live events follow;
 * a comment heartbeat keeps intermediaries from closing an idle stream.
 */

import { API_PREFIX } from "./api.js";

/** Exact path of the live event stream. */
export const LIVE_PATH = "/dsh-remote/live";
/** Heartbeat cadence (ms) for an otherwise idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * @param {object} deps
 * @param {object} deps.ctx Cordis context (optional connection fence).
 * @param {object} deps.hub Live hub (`lib/live.js`).
 * @param {{ warn?: (message: string) => void }} [deps.logger]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 */
export function createLiveStreamHandler({ ctx, hub, logger }) {
  if (hub === undefined || hub === null) throw new Error("createLiveStreamHandler: hub is required");

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // ignore
    }
  };

  return function handler(req, res) {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }

    const connection = ctx?.get?.("connection");
    if (connection === undefined || connection === null) {
      writeJsonError(res, 503, "FENCE_UNAVAILABLE", "browser trust checks are unavailable");
      return;
    }
    let rejection;
    try {
      rejection = connection.requestRejection?.(req);
    } catch (error) {
      warn(`dsh-remote: live fence failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJsonError(res, 503, "FENCE_ERROR", "browser trust checks failed");
      return;
    }
    if (rejection !== undefined && rejection !== false && rejection !== null) {
      writeJsonError(res, 403, "FORBIDDEN", "forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", "http://dsh.local");
    if (url.pathname.replace(/\/+$/u, "") !== LIVE_PATH) {
      writeJsonError(res, 404, "NOT_FOUND", `unknown live route (management API is ${API_PREFIX})`);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    /** @param {object} payload */
    const send = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // stream torn down between events
      }
    };

    send(hub.snapshot());
    const unsubscribe = hub.subscribe(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  };
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {string} code @param {string} message */
function writeJsonError(res, status, code, message) {
  const body = JSON.stringify({ ok: false, error: { code, message } });
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}
