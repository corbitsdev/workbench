import { expect, test } from "bun:test";
import { Hono } from "hono";

import { createInFlightRequestTracker } from "./in-flight-requests";

test("pending starts at zero and whenIdle resolves immediately", async () => {
  const tracker = createInFlightRequestTracker();
  expect(tracker.pending).toBe(0);
  await tracker.whenIdle();
  expect(tracker.pending).toBe(0);
});

test("middleware counts a request until the handler returns", async () => {
  const tracker = createInFlightRequestTracker();
  const app = new Hono();
  app.use(tracker.middleware);
  let pendingDuringHandler: number | undefined;
  app.get("/work", async () => {
    pendingDuringHandler = tracker.pending;
    return new Response("ok");
  });

  const response = await app.request("/work");
  expect(response.status).toBe(200);
  expect(pendingDuringHandler).toBe(1);
  expect(tracker.pending).toBe(0);
});

test("whenIdle waits for an in-flight handler, including one that throws", async () => {
  const tracker = createInFlightRequestTracker();
  const app = new Hono();
  app.use(tracker.middleware);
  app.onError(() => new Response("error", { status: 500 }));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.get("/held", async () => {
    await held;
    throw new Error("handler fault");
  });

  const request = app.request("/held");
  const idle = tracker.whenIdle();
  let idleSettled = false;
  void idle.then(() => {
    idleSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(tracker.pending).toBe(1);
  expect(idleSettled).toBe(false);

  release();
  await request;
  await idle;
  expect(idleSettled).toBe(true);
  expect(tracker.pending).toBe(0);
});
