// Route-level tests: request parsing, grant gating, and error-envelope
// mapping against the in-memory store. Merge semantics themselves are
// covered in store.test.ts.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createPreferencesRoutes } from "./routes";
import { createMemoryPreferencesStore } from "./store";

const TENANT = { id: "tnt_1" };
const PRINCIPAL = { id: "prn_1" };

function buildApp(opts?: {
  store?: ReturnType<typeof createMemoryPreferencesStore>;
  denyWrite?: boolean;
}): Hono<TenantEnv> {
  const store = opts?.store ?? createMemoryPreferencesStore();
  const routes = createPreferencesRoutes({
    store,
    requireGrant: (_resource, action) => async (c, next) => {
      if (opts?.denyWrite === true && action === "write") {
        return c.json({ error: { code: "forbidden", message: "no" } }, 403);
      }
      await next();
    },
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

test("GET / returns {} default preferences", async () => {
  const app = buildApp();
  const response = await app.request("/");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { preferences: unknown };
  expect(body.preferences).toEqual({});
});

test("PATCH / merges and GET / reflects the patched value", async () => {
  const app = buildApp();
  const patchResponse = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "shell.col2Collapsed": true }),
  });
  expect(patchResponse.status).toBe(200);
  const patchBody = (await patchResponse.json()) as {
    preferences: Record<string, unknown>;
  };
  expect(patchBody.preferences).toEqual({ "shell.col2Collapsed": true });

  const getResponse = await app.request("/");
  const getBody = (await getResponse.json()) as {
    preferences: Record<string, unknown>;
  };
  expect(getBody.preferences).toEqual({ "shell.col2Collapsed": true });
});

test("PATCH / with a non-object body 400s", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("not an object"),
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
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  };
  app.use("*", asPrincipal);
  app.route(
    "/",
    createPreferencesRoutes({
      store: createMemoryPreferencesStore(),
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
    body: JSON.stringify({ a: 1 }),
  });
  expect(response.status).toBe(403);

  const getResponse = await app.request("/");
  expect(getResponse.status).toBe(200);
});
