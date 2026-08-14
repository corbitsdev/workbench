// Exercises `createConnectionRoutes`' HTTP surface: unknown connector,
// malformed body, the test route's pass/reject outcomes, and the
// complete route's storage handoff — mounted into a bare `Hono` with a
// tenant-injecting middleware, mirroring
// `packages/webhook-triggers/test/management-routes.test.ts`. A fake
// registry stands in for `CONNECTOR_REGISTRY` so every probe outcome is
// deterministic and nothing here ever touches the real network.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ConnectorDescriptor } from "./descriptor";
import { createConnectionRoutes } from "./routes";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_alice",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_alice",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

const FAKE_REGISTRY: Readonly<Record<string, ConnectorDescriptor>> = {
  "accepting-connector": {
    id: "accepting-connector",
    displayName: "Accepting Connector",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://example.test/docs",
    feedsTools: [],
    probe: async () => ({ ok: true }),
  },
  "rejecting-connector": {
    id: "rejecting-connector",
    displayName: "Rejecting Connector",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://example.test/docs",
    feedsTools: [],
    probe: async () => ({ ok: false, message: "the key was rejected" }),
  },
  "display-only-connector": {
    id: "display-only-connector",
    displayName: "Display Only Connector",
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: "https://example.test/docs",
    feedsTools: [],
  },
};

function mountAs(routes: Hono<TenantEnv>): Hono<TenantEnv> {
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

function buildApp(
  overrides: {
    requireGrant?: RequireGrant;
    ensureProviderFn?: Parameters<
      typeof createConnectionRoutes
    >[0]["ensureProviderFn"];
    ensureCredentialFn?: Parameters<
      typeof createConnectionRoutes
    >[0]["ensureCredentialFn"];
  } = {},
) {
  const routes = createConnectionRoutes({
    hubUrl: "http://hub.test",
    requireGrant: overrides.requireGrant ?? allowAll,
    log: () => {},
    registry: FAKE_REGISTRY,
    ...(overrides.ensureProviderFn !== undefined
      ? { ensureProviderFn: overrides.ensureProviderFn }
      : {}),
    ...(overrides.ensureCredentialFn !== undefined
      ? { ensureCredentialFn: overrides.ensureCredentialFn }
      : {}),
  });
  return mountAs(routes);
}

describe("POST /:connectorId/credential/test", () => {
  test("unknown connector 404s", async () => {
    const app = buildApp();
    const response = await app.request("/not-a-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "test-key" }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("a display-only connector (no probe) 404s", async () => {
    const app = buildApp();
    const response = await app.request(
      "/display-only-connector/credential/test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "test-key" }),
      },
    );
    expect(response.status).toBe(404);
  });

  test("malformed body 400s", async () => {
    const app = buildApp();
    const response = await app.request("/accepting-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a rejected probe 422s with no storage", async () => {
    const app = buildApp();
    const response = await app.request("/rejecting-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_credential");
  });

  test("an accepted probe 200s with no storage", async () => {
    const app = buildApp();
    const response = await app.request("/accepting-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("POST /:connectorId/complete", () => {
  test("unknown connector 404s", async () => {
    const app = buildApp();
    const response = await app.request("/not-a-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "test-key" }),
    });
    expect(response.status).toBe(404);
  });

  test("a rejected probe 422s and never reaches storage", async () => {
    const ensureProviderFn = async () => {
      throw new Error("should never be called");
    };
    const app = buildApp({ ensureProviderFn });
    const response = await app.request("/rejecting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    expect(response.status).toBe(422);
  });

  test("stores the credential once the probe accepts, returning its id", async () => {
    // The provider row is named by the connector's lowercase id — the
    // canonical name credentialBindings resolve against via the
    // platform's case-sensitive provider lookup. displayName never
    // reaches a provider row.
    let providerRowName: string | undefined;
    const app = buildApp({
      ensureProviderFn: async (_api, _cookies, args) => {
        providerRowName = (args as { name: string }).name;
        return "prv_1";
      },
      ensureCredentialFn: async () => "crd_1",
    });
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      credentialId: string;
      status: string;
    };
    expect(body.credentialId).toBe("crd_1");
    expect(body.status).toBe("active");
    expect(providerRowName).toBe("accepting-connector");
  });

  test("a storage failure after a good probe 500s", async () => {
    const app = buildApp({
      ensureProviderFn: async () => {
        throw new Error("hub unreachable");
      },
    });
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("connection_setup_failed");
  });
});
