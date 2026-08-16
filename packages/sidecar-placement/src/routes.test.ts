// Route-level tests: request parsing, grant gating, and error-envelope
// mapping against the in-memory store. Persistence semantics themselves
// are covered in store.test.ts.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createSidecarPlacementRoutes } from "./routes";
import { createMemorySidecarPlacementStore } from "./store";

const TENANT = { id: "tnt_1" };

function buildApp(opts?: {
  store?: ReturnType<typeof createMemorySidecarPlacementStore>;
  denyWrite?: boolean;
  hasProvisioner?: boolean;
}): Hono<TenantEnv> {
  const store = opts?.store ?? createMemorySidecarPlacementStore();
  const routes = createSidecarPlacementRoutes({
    store,
    hasProvisioner: opts?.hasProvisioner ?? true,
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

test("GET / is disabled by default", async () => {
  const app = buildApp();
  const response = await app.request("/");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    provisionerAvailable: true,
  });
});

test("PUT / enables and GET / reflects it", async () => {
  const app = buildApp();
  const putResponse = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(putResponse.status).toBe(200);
  expect(await putResponse.json()).toEqual({
    enabled: true,
    provisionerAvailable: true,
  });

  const getResponse = await app.request("/");
  expect(await getResponse.json()).toEqual({
    enabled: true,
    provisionerAvailable: true,
  });
});

test("PUT / with enabled: false clears it", async () => {
  const store = createMemorySidecarPlacementStore();
  await store.setEnabled(TENANT.id, true);
  const app = buildApp({ store });

  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    provisionerAvailable: true,
  });
});

test("GET / exposes provisionerAvailable: false when the hub has no provisioner", async () => {
  const app = buildApp({ hasProvisioner: false });
  const response = await app.request("/");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    provisionerAvailable: false,
  });
});

test("PUT / enabling exclusive placement 409s when the hub has no provisioner", async () => {
  const store = createMemorySidecarPlacementStore();
  const app = buildApp({ store, hasProvisioner: false });

  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("no_provisioner_configured");
  expect(await store.getEnabled(TENANT.id)).toBe(false);
});

test("PUT / disabling exclusive placement still works with no provisioner", async () => {
  const store = createMemorySidecarPlacementStore();
  await store.setEnabled(TENANT.id, true);
  const app = buildApp({ store, hasProvisioner: false });

  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    provisionerAvailable: false,
  });
});

test("PUT / with a non-boolean enabled 400s", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("PUT / with no body / invalid JSON 400s rather than 500", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "PUT",
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
    createSidecarPlacementRoutes({
      store: createMemorySidecarPlacementStore(),
      hasProvisioner: true,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    }),
  );
  const response = await app.request("/");
  expect(response.status).toBe(403);
});

test("PUT / is gated by requireGrant separately from GET", async () => {
  const app = buildApp({ denyWrite: true });
  const response = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(403);

  const getResponse = await app.request("/");
  expect(getResponse.status).toBe(200);
});
