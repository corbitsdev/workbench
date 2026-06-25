import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createRateLimiter } from "./rate-limit";

function buildApp(now: () => number) {
  const app = new Hono();
  app.use(
    "/sign-in",
    createRateLimiter({
      windowMs: 60_000,
      max: 2,
      keyForRequest: (c) => c.req.header("x-forwarded-for") ?? "unknown",
      now,
    }),
  );
  app.post("/sign-in", (c) => c.json({ ok: true }));
  return app;
}

function signIn(app: Hono, ip: string) {
  return app.fetch(
    new Request("http://localhost/sign-in", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    }),
  );
}

describe("createRateLimiter", () => {
  it("allows requests up to the max within a window", async () => {
    const app = buildApp(() => 1000);
    expect((await signIn(app, "1.1.1.1")).status).toBe(200);
    expect((await signIn(app, "1.1.1.1")).status).toBe(200);
  });

  it("returns 429 with Retry-After once the max is exceeded", async () => {
    const app = buildApp(() => 1000);
    await signIn(app, "1.1.1.1");
    await signIn(app, "1.1.1.1");
    const res = await signIn(app, "1.1.1.1");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("tracks limits per key independently", async () => {
    const app = buildApp(() => 1000);
    await signIn(app, "1.1.1.1");
    await signIn(app, "1.1.1.1");
    expect((await signIn(app, "1.1.1.1")).status).toBe(429);
    expect((await signIn(app, "2.2.2.2")).status).toBe(200);
  });

  it("resets the bucket after the window elapses", async () => {
    let clock = 1000;
    const app = buildApp(() => clock);
    await signIn(app, "1.1.1.1");
    await signIn(app, "1.1.1.1");
    expect((await signIn(app, "1.1.1.1")).status).toBe(429);
    clock += 60_001;
    expect((await signIn(app, "1.1.1.1")).status).toBe(200);
  });

  it("keys off the trusted last forwarded hop, not the spoofable client-supplied value", async () => {
    // Default keyForRequest. Two requests forge different leftmost IPs but share
    // the same real client appended last by the trusted proxy: they must share a
    // bucket so the spoof does not buy a fresh limit.
    const app = new Hono();
    app.use(
      "/sign-in",
      createRateLimiter({ windowMs: 60_000, max: 2, now: () => 1000 }),
    );
    app.post("/sign-in", (c) => c.json({ ok: true }));
    const forge = (leftmost: string) =>
      app.fetch(
        new Request("http://localhost/sign-in", {
          method: "POST",
          headers: { "x-forwarded-for": `${leftmost}, 9.9.9.9` },
        }),
      );
    expect((await forge("1.1.1.1")).status).toBe(200);
    expect((await forge("2.2.2.2")).status).toBe(200);
    expect((await forge("3.3.3.3")).status).toBe(429);
  });

  it("does not limit (and does not share a bucket) when there is no trusted forwarded hop", async () => {
    // Default keyForRequest: requests with no x-forwarded-for must NOT collapse
    // onto one shared bucket, or a few header-less clients could lock out all
    // sign-ins. They are skipped entirely.
    const app = new Hono();
    app.use(
      "/sign-in",
      createRateLimiter({ windowMs: 60_000, max: 2, now: () => 1000 }),
    );
    app.post("/sign-in", (c) => c.json({ ok: true }));
    const noHeader = () =>
      app.fetch(new Request("http://localhost/sign-in", { method: "POST" }));
    for (let i = 0; i < 25; i += 1) {
      expect((await noHeader()).status).toBe(200);
    }
  });

  it("ignores x-real-ip (spoofable) and only trusts the forwarded last hop", async () => {
    const app = new Hono();
    app.use(
      "/sign-in",
      createRateLimiter({ windowMs: 60_000, max: 2, now: () => 1000 }),
    );
    app.post("/sign-in", (c) => c.json({ ok: true }));
    const forgeRealIp = (ip: string) =>
      app.fetch(
        new Request("http://localhost/sign-in", {
          method: "POST",
          headers: { "x-real-ip": ip },
        }),
      );
    // Rotating x-real-ip without a forwarded hop is not trusted → not limited.
    for (let i = 0; i < 10; i += 1) {
      expect((await forgeRealIp(`9.9.9.${i}`)).status).toBe(200);
    }
  });

  it("fails open instead of growing unbounded once the tracked-key cap is reached", async () => {
    let clock = 1000;
    const app = new Hono();
    app.use(
      "/sign-in",
      createRateLimiter({
        windowMs: 60_000,
        max: 1,
        maxTrackedKeys: 2,
        now: () => clock,
        keyForRequest: (c) => c.req.header("x-forwarded-for") ?? "x",
      }),
    );
    app.post("/sign-in", (c) => c.json({ ok: true }));
    const hit = (ip: string) =>
      app.fetch(
        new Request("http://localhost/sign-in", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
        }),
      );

    // Fill the cap with two active buckets.
    expect((await hit("a")).status).toBe(200);
    expect((await hit("b")).status).toBe(200);
    // Advance past the window so the existing buckets are expired but still in
    // the map, then a new key triggers a sweep and is admitted.
    clock += 60_001;
    expect((await hit("c")).status).toBe(200);
  });
});
