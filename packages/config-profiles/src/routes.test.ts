// Route-level tests: request parsing, grant gating, and error-envelope
// mapping against the in-memory store — mirrors
// `@corbits/preferences`/`@corbits/routines`' own `routes.test.ts`.
// `/capture` and `/apply` additionally exercise the self-fetch seam
// against a stubbed `globalThis.fetch`.
import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createConfigProfileRoutes } from "./routes";
import { createInMemoryConfigProfileStore } from "./store";

const TENANT = { id: "tnt_workspace" };
const PRINCIPAL = { id: "prn_1" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function buildApp(opts?: {
  store?: ReturnType<typeof createInMemoryConfigProfileStore>;
  denyWrite?: boolean;
}): Hono<TenantEnv> {
  const store = opts?.store ?? createInMemoryConfigProfileStore();
  const routes = createConfigProfileRoutes({
    store,
    requireGrant: (_resource, action) => async (c, next) => {
      if (opts?.denyWrite === true && action !== "read") {
        return c.json({ error: { code: "forbidden", message: "no" } }, 403);
      }
      await next();
    },
    hubBaseUrl: "https://hub.test",
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

test("POST / then GET / round-trips a profile", async () => {
  const app = buildApp();
  const created = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Fast & cheap",
      entries: [{ provider: "OpenAI", model: "gpt-5" }],
    }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { id: string; name: string };
  expect(createdBody.name).toBe("Fast & cheap");

  const list = await app.request("/");
  const listBody = (await list.json()) as { items: { id: string }[] };
  expect(listBody.items.map((i) => i.id)).toEqual([createdBody.id]);

  const got = await app.request(`/${createdBody.id}`);
  expect(got.status).toBe(200);
});

test("POST / with an empty name 400s", async () => {
  const app = buildApp();
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "", entries: [] }),
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("GET /:id for an unknown id 404s", async () => {
  const app = buildApp();
  const response = await app.request("/nope");
  expect(response.status).toBe(404);
});

test("PATCH /:id updates and DELETE /:id removes it", async () => {
  const app = buildApp();
  const created = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "A", entries: [] }),
  });
  const { id } = (await created.json()) as { id: string };

  const patched = await app.request(`/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "B" }),
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { name: string }).name).toBe("B");

  const deleted = await app.request(`/${id}`, { method: "DELETE" });
  expect(deleted.status).toBe(204);

  const gone = await app.request(`/${id}`);
  expect(gone.status).toBe(404);
});

test("DELETE /:id for an unknown id 404s", async () => {
  const app = buildApp();
  const response = await app.request("/nope", { method: "DELETE" });
  expect(response.status).toBe(404);
});

test("write routes are gated by requireGrant separately from read", async () => {
  const app = buildApp({ denyWrite: true });
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "A", entries: [] }),
  });
  expect(response.status).toBe(403);

  const readResponse = await app.request("/");
  expect(readResponse.status).toBe(200);
});

test("POST /capture creates a profile from a stubbed workbench catalog", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(
        JSON.stringify([
          {
            id: "mdl_1",
            canonicalName: "gpt-5",
            offerings: [
              {
                offeringId: "ofr_1",
                providerId: "prv_1",
                providerName: "OpenAI",
                plugin: "openai",
                priority: 0,
                deploymentTags: [],
                capabilities: [],
                pricing: [],
              },
            ],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const app = buildApp();
  const response = await app.request("/capture", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "session=abc123",
    },
    body: JSON.stringify({
      targetTenantId: "wbn_1",
      name: "Captured",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    name: string;
    entries: { provider: string; model: string }[];
  };
  expect(body.name).toBe("Captured");
  expect(body.entries).toEqual([{ provider: "OpenAI", model: "gpt-5" }]);
});

test("POST /apply for an unknown profile 404s", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const app = buildApp();
  const response = await app.request("/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: "nope", targetTenantId: "wbn_1" }),
  });
  expect(response.status).toBe(404);
});

const applyModels = [
  {
    id: "mdl_1",
    canonicalName: "gpt-5",
    offerings: [
      {
        offeringId: "ofr_a",
        providerId: "prv_a",
        providerName: "OpenAI",
        plugin: "openai",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
      {
        offeringId: "ofr_b",
        providerId: "prv_b",
        providerName: "Azure",
        plugin: "openai",
        priority: 1,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
];

const applyOwnOfferings = ["ofr_a", "ofr_b"].map((id) => ({
  id,
  tenantId: "wbn_1",
  modelId: "mdl_1",
  providerId: id === "ofr_a" ? "prv_a" : "prv_b",
  priority: id === "ofr_a" ? 0 : 1,
  deploymentTags: [],
  capabilities: [],
  quirks: null,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

test("selfFetch forwards the caller's cookie header on every self-call", async () => {
  const cookies: (string | null)[] = [];
  const { app, store } = (() => {
    const store = createInMemoryConfigProfileStore();
    return { app: buildApp({ store }), store };
  })();
  const profile = await store.createProfile({
    tenantId: TENANT.id,
    name: "P",
    entries: [{ provider: "OpenAI", model: "gpt-5" }],
    createdBy: PRINCIPAL.id,
  });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    cookies.push(new Headers(init?.headers).get("cookie"));
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/models")) {
      return Response.json(applyModels);
    }
    if (method === "GET" && url.endsWith("/catalog/offerings")) {
      return Response.json({ data: applyOwnOfferings, nextCursor: null });
    }
    return Response.json({
      id: "ofr_a",
      tenantId: "wbn_1",
      modelId: "mdl_1",
      providerId: "prv_a",
      priority: 0,
      deploymentTags: [],
      capabilities: [],
      quirks: null,
      disabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }) as typeof fetch;

  const response = await app.request("/apply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "session=abc123; other=x",
    },
    body: JSON.stringify({ profileId: profile.id, targetTenantId: "wbn_1" }),
  });
  expect(response.status).toBe(200);
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie).toBe("session=abc123; other=x");
  }
});

test("/apply against a workbench whose native routes answer 403 maps to a 403 with a plain message", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: { code: "forbidden", message: "no" } },
      { status: 403 },
    )) as unknown as typeof fetch;

  const store = createInMemoryConfigProfileStore();
  const app = buildApp({ store });
  const profile = await store.createProfile({
    tenantId: TENANT.id,
    name: "P",
    entries: [{ provider: "OpenAI", model: "gpt-5" }],
    createdBy: PRINCIPAL.id,
  });
  const response = await app.request("/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId: profile.id,
      targetTenantId: "wbn_other",
    }),
  });
  expect(response.status).toBe(403);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("forbidden");
});

test("PATCH failure mid-sequence: reports what succeeded, what failed, and what was never attempted", async () => {
  const patched: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/models")) {
      return Response.json(applyModels);
    }
    if (method === "GET" && url.endsWith("/catalog/offerings")) {
      return Response.json({ data: applyOwnOfferings, nextCursor: null });
    }
    const offeringId = url.split("/").pop() ?? "";
    if (offeringId === "ofr_b") {
      return Response.json(
        { error: { code: "boom", message: "db down" } },
        { status: 500 },
      );
    }
    patched.push(offeringId);
    return Response.json({
      id: offeringId,
      tenantId: "wbn_1",
      modelId: "mdl_1",
      providerId: "prv_a",
      priority: 0,
      deploymentTags: [],
      capabilities: [],
      quirks: null,
      disabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }) as typeof fetch;

  const store = createInMemoryConfigProfileStore();
  const app = buildApp({ store });
  const profile = await store.createProfile({
    tenantId: TENANT.id,
    name: "P",
    entries: [
      { provider: "OpenAI", model: "gpt-5" },
      { provider: "Azure", model: "gpt-5" },
    ],
    createdBy: PRINCIPAL.id,
  });
  const response = await app.request("/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, targetTenantId: "wbn_1" }),
  });
  expect(patched).toEqual(["ofr_a"]);
  expect(response.status).toBe(502);
  const body = (await response.json()) as {
    ok: boolean;
    results: unknown[];
  };
  expect(body.ok).toBe(false);
  expect(body.results).toEqual([
    {
      provider: "OpenAI",
      model: "gpt-5",
      action: "reordered",
      offeringId: "ofr_a",
      priority: 0,
      disabled: false,
    },
    {
      provider: "Azure",
      model: "gpt-5",
      action: "failed",
      offeringId: "ofr_b",
      message: "db down",
      status: 500,
    },
  ]);
});
