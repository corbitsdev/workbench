import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createSidecarWsDrainGuard } from "./drain-guard";
import { beginDrain, isDraining } from "./drain-state";

function buildTestApp(): Hono {
  const app = new Hono();
  app.use("/api/sidecars/ws", createSidecarWsDrainGuard());
  app.get("/api/sidecars/ws", (c) => c.text("upgraded"));
  app.get("/api/other", (c) => c.text("ok"));
  return app;
}

describe("createSidecarWsDrainGuard", () => {
  it("passes the sidecar WS route through before drain begins", async () => {
    expect(isDraining()).toBe(false);
    const app = buildTestApp();
    const res = await app.request("/api/sidecars/ws");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upgraded");
  });

  it("refuses the sidecar WS route with 503 once draining has begun", async () => {
    const app = buildTestApp();
    beginDrain();
    try {
      const res = await app.request("/api/sidecars/ws");
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "hub draining" });
    } finally {
      // no reset primitive exists by design (drain is one-way for the process
      // lifetime); the next test in this file relies on ordering only, so
      // isolate any future non-drain assertions in a separate test file.
    }
  });

  it("leaves other routes unaffected while draining", async () => {
    expect(isDraining()).toBe(true);
    const app = buildTestApp();
    const res = await app.request("/api/other");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
