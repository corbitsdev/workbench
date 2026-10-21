import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createStaticWebHandler,
  isStaticWebRequest,
  populateDbEnvFromDatabaseUrl,
  withStaticWeb,
} from "./static-web";

function makeDistDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "workbench-static-web-"));
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="root">INDEX</div>');
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('ok');");
  return dir;
}

describe("static web serving", () => {
  test("serves hashed assets with immutable Cache-Control and SPA routes with index.html", async () => {
    const dir = makeDistDir();
    const serve = createStaticWebHandler(dir);

    const assetRes = await serve(new Request("http://localhost:3000/assets/app-abc123.js"));
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await assetRes.text()).toBe("console.log('ok');");

    const spaRes = await serve(new Request("http://localhost:3000/benches/default/threads/123"));
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get("cache-control")).toBe("no-cache");
    expect(await spaRes.text()).toContain("INDEX");
  });

  test("returns 404 for missing asset files with an extension instead of index.html", async () => {
    const dir = makeDistDir();
    const serve = createStaticWebHandler(dir);

    const missing = await serve(new Request("http://localhost:3000/assets/missing.js"));
    expect(missing.status).toBe(404);
  });

  test("never serves files outside the dist directory on path traversal", async () => {
    const dir = makeDistDir();
    writeFileSync(path.join(tmpdir(), "outside-secret.txt"), "TOP_SECRET");
    const serve = createStaticWebHandler(dir);

    const escaped = await serve(new Request("http://localhost:3000/%2e%2e%2foutside-secret.txt"));
    expect(escaped.status).toBe(200);
    expect(await escaped.text()).toContain("INDEX");
  });

  test("delegates /api/*, /status, /openapi.json, and non-GET/HEAD requests to the hub", async () => {
    const dir = makeDistDir();
    const wrapped = withStaticWeb(dir, () => Response.json({ hub: true }));

    expect(isStaticWebRequest(new Request("http://localhost:3000/api/me"))).toBe(false);
    expect(isStaticWebRequest(new Request("http://localhost:3000/status"))).toBe(false);
    expect(isStaticWebRequest(new Request("http://localhost:3000/openapi.json"))).toBe(false);
    expect(
      isStaticWebRequest(new Request("http://localhost:3000/benches", { method: "POST" })),
    ).toBe(false);

    const apiRes = await wrapped(new Request("http://localhost:3000/api/me"), undefined);
    expect(await apiRes.json()).toEqual({ hub: true });

    const rootRes = await wrapped(new Request("http://localhost:3000/"), undefined);
    expect(await rootRes.text()).toContain("INDEX");
  });

  test("populates DB_* variables from DATABASE_URL without overwriting explicit overrides", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "postgres://workbench:secret%40pass@postgres:5433/workbench_prod",
      DB_HOST: "explicit-host",
    };
    populateDbEnvFromDatabaseUrl(env);
    expect(env["DB_HOST"]).toBe("explicit-host");
    expect(env["DB_PORT"]).toBe("5433");
    expect(env["DB_USER"]).toBe("workbench");
    expect(env["DB_PASSWORD"]).toBe("secret@pass");
    expect(env["DB_NAME"]).toBe("workbench_prod");
  });
});
