// A real Bun.serve() with a live websocket or SSE stream reproduces the
// drain hang that unit tests on drainWithTimeout (src/shutdown.test.ts)
// cannot see: `server.stop()` with no argument waits for those connections
// to close on their own, and they never do. The hub drain waits for the
// Hono in-flight request counter instead, then force-stops so lingering
// streams cannot turn a deploy into a timeout fault.
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";

import {
  createInFlightRequestTracker,
  withInFlightRequestTracking,
} from "../src/in-flight-requests";
import { drainHubServer, drainWithTimeout, shutdownHub } from "../src/shutdown";

type Serving = {
  port: number;
  stop: (force?: boolean) => Promise<void>;
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function serve(app: Hono): Serving {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: app.fetch,
    websocket,
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("Bun.serve did not bind a port");
  }
  cleanups.push(() => {
    void server.stop(true);
  });
  return {
    port,
    stop: (force = false) => server.stop(force),
  };
}

function startTracked(): {
  inner: Hono;
  tracker: ReturnType<typeof createInFlightRequestTracker>;
  serve: () => Serving;
} {
  const tracker = createInFlightRequestTracker();
  const inner = new Hono();
  return {
    inner,
    tracker,
    serve: () => serve(withInFlightRequestTracking(inner, tracker)),
  };
}

async function openWebSocket(port: number, path = "/ws"): Promise<WebSocket> {
  const client = new WebSocket(`ws://localhost:${String(port)}${path}`);
  cleanups.push(() => client.close());
  await new Promise<void>((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true });
    client.addEventListener("error", reject, { once: true });
  });
  return client;
}

describe("hub shutdown drain against a real server", () => {
  test("server.stop() with no argument never drains while a websocket stays open", async () => {
    const app = new Hono();
    app.get(
      "/ws",
      upgradeWebSocket(() => ({
        onMessage() {
          // The socket just stays open.
        },
      })),
    );
    const server = serve(app);
    await openWebSocket(server.port);

    const outcome = await drainWithTimeout(() => server.stop(), 200);
    expect(outcome).toEqual({ kind: "timed-out" });
  });

  test("drainHubServer force-stops after in-flight handlers finish, even with a live websocket", async () => {
    const { inner, tracker, serve: start } = startTracked();
    let handlerFinished = false;
    inner.get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      handlerFinished = true;
      return new Response("ok");
    });
    inner.get(
      "/ws",
      upgradeWebSocket(() => ({
        onMessage() {
          // The socket just stays open.
        },
      })),
    );
    const server = start();
    await openWebSocket(server.port);

    const inFlight = fetch(`http://localhost:${String(server.port)}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracker.pending).toBe(1);

    const outcome = await drainWithTimeout(
      () =>
        drainHubServer({
          whenRequestsIdle: () => tracker.whenIdle(),
          stop: (force) => server.stop(force),
          close: () => Promise.resolve(),
        }),
      1_000,
    );
    expect(outcome).toEqual({ kind: "drained" });
    expect(handlerFinished).toBe(true);
    expect(tracker.pending).toBe(0);

    await inFlight.catch(() => undefined);
  });

  test("a live SSE stream does not hold the in-flight count or fail drain", async () => {
    const { inner, tracker, serve: start } = startTracked();
    inner.get("/stream", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: "hello" });
        await new Promise<void>(() => undefined);
      }),
    );
    const server = start();
    const response = await fetch(
      `http://localhost:${String(server.port)}/stream`,
    );
    expect(response.ok).toBe(true);
    expect(tracker.pending).toBe(0);

    let exitCode: number | undefined;
    const reported: unknown[] = [];
    await shutdownHub({
      drain: () =>
        drainHubServer({
          whenRequestsIdle: () => tracker.whenIdle(),
          stop: (force) => server.stop(force),
          close: () => Promise.resolve(),
        }),
      timeoutMs: 1_000,
      exit: (code) => {
        exitCode = code;
      },
      report: (error) => {
        reported.push(error);
        return "unused-ref-id";
      },
    });
    expect(exitCode).toBe(0);
    expect(reported).toEqual([]);

    await response.body?.cancel().catch(() => undefined);
  });
});
