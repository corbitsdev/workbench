// Route-level tests: request parsing, grant gating, and error-envelope
// mapping against the in-memory store. Merge semantics themselves are
// covered in store.test.ts.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createBenchRoutes } from "./routes";
import { createMemoryBenchSettingsStore } from "./store";

const TENANT = { id: "tnt_1" };

function buildApp(opts?: {
  store?: ReturnType<typeof createMemoryBenchSettingsStore>;
  denyWrite?: boolean;
}): Hono<TenantEnv> {
  const store = opts?.store ?? createMemoryBenchSettingsStore();
  const routes = createBenchRoutes({
    store,
    requireGrant: (_resource, action) => async (c, next) => {
      if (opts?.denyWrite === true && action === "write") {
        return c.json({ error: { code: "forbidden", message: "no" } }, 403);
      }
      await next();
    },
  });
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

test("GET / returns null purpose/type by default", async () => {
  const app = buildApp();
  const response = await app.request("/");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { purpose: unknown; type: unknown };
  expect(body).toEqual({ purpose: null, type: null });
});

test("PATCH / persists and GET / reflects the patched value", async () => {
  const app = buildApp();
  const patchResponse = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "Launch planning", type: "global" }),
  });
  expect(patchResponse.status).toBe(200);
  const patchBody = (await patchResponse.json()) as {
    purpose: string;
    type: string;
  };
  expect(patchBody).toEqual({ purpose: "Launch planning", type: "global" });

  const getResponse = await app.request("/");
  const getBody = (await getResponse.json()) as {
    purpose: string;
    type: string;
  };
  expect(getBody).toEqual({ purpose: "Launch planning", type: "global" });
});

test("PATCH / with an unknown type value 400s", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "nonexistent" }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("PATCH / with no body / invalid JSON 400s rather than 500", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  expect(response.status).toBe(400);
});

test("GET / is gated by requireGrant", async () => {
  const app = new Hono<TenantEnv>();
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    await next();
  };
  app.use("*", asTenant);
  app.route(
    "/",
    createBenchRoutes({
      store: createMemoryBenchSettingsStore(),
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    }),
  );
  const response = await app.request("/");
  expect(response.status).toBe(403);
});

test("PATCH / is gated by requireGrant separately from GET", async () => {
  const app = buildApp({ denyWrite: true });
  const response = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "x" }),
  });
  expect(response.status).toBe(403);

  const getResponse = await app.request("/");
  expect(getResponse.status).toBe(200);
});
