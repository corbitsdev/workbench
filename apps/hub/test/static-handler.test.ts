// `createStaticHandler` serves the SPA from the hub origin and sits ahead
// of every non-/api route, so it sees any attacker-controlled path a
// client cares to send — including one with a malformed percent-escape
// (`GET /%zz`). `decodeURIComponent` throws on that, and until this was
// guarded the throw escaped the handler entirely: a 500 on any
// non-/api request, not the 404/index.html fallback every other
// unresolvable path gets.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";

import { createStaticHandler } from "../src/index.ts";

let staticDir: string;

beforeAll(() => {
  staticDir = mkdtempSync(path.join(tmpdir(), "hub-static-"));
  writeFileSync(path.join(staticDir, "index.html"), "<html>spa</html>");
});

afterAll(() => {
  rmSync(staticDir, { recursive: true, force: true });
});

function buildApp() {
  const app = new Hono();
  app.get("/*", createStaticHandler(staticDir) as never);
  app.notFound((c: Context) => c.text("not found", 404));
  return app;
}

describe("createStaticHandler", () => {
  test("serves index.html for a normal SPA route", async () => {
    const app = buildApp();
    const response = await app.request("/workbenches/ch_1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>spa</html>");
  });

  test("a malformed percent-escape 404s instead of throwing", async () => {
    const app = buildApp();
    const response = await app.request("/%zz");
    expect(response.status).toBe(404);
  });

  test("/api paths are left for the platform routes regardless", async () => {
    const app = buildApp();
    const response = await app.request("/api/%zz");
    expect(response.status).toBe(404);
  });
});
