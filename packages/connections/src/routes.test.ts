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
import { createProviderHealthStore } from "./provider-health";
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
  "unconfigured-oauth-connector": {
    id: "unconfigured-oauth-connector",
    displayName: "Unconfigured OAuth Connector",
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: "https://example.test/docs",
    feedsTools: [],
    oauth: {
      authorizeUrl: "https://example.test/authorize",
      usesPKCE: true,
      echoesState: false,
      deploysDefaultWorkflows: false,
      clientId: (env) => env["unconfiguredOauthConnectorClientId"],
      buildAuthorizeUrl: ({ callbackUrl }) =>
        new URL(`https://example.test/authorize?redirect_uri=${callbackUrl}`),
      exchange: async () => ({ ok: true, apiKey: "unused" }),
    },
  },
  "no-client-id-needed-connector": {
    id: "no-client-id-needed-connector",
    displayName: "No Client Id Needed Connector",
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: "https://example.test/docs",
    feedsTools: [],
    oauth: {
      authorizeUrl: "https://example.test/authorize",
      usesPKCE: true,
      echoesState: false,
      deploysDefaultWorkflows: false,
      buildAuthorizeUrl: ({ callbackUrl }) =>
        new URL(`https://example.test/authorize?redirect_uri=${callbackUrl}`),
      exchange: async () => ({ ok: true, apiKey: "unused" }),
    },
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
    oauthEnv?: Readonly<Record<string, string | undefined>>;
    providerHealth?: Parameters<
      typeof createConnectionRoutes
    >[0]["providerHealth"];
    listConnectedProviders?: Parameters<
      typeof createConnectionRoutes
    >[0]["listConnectedProviders"];
  } = {},
) {
  const routeArgs: Parameters<typeof createConnectionRoutes>[0] = {
    hubUrl: "http://hub.test",
    requireGrant: overrides.requireGrant ?? allowAll,
    log: () => {},
    registry: FAKE_REGISTRY,
  };
  if (overrides.ensureProviderFn !== undefined)
    routeArgs.ensureProviderFn = overrides.ensureProviderFn;
  if (overrides.ensureCredentialFn !== undefined)
    routeArgs.ensureCredentialFn = overrides.ensureCredentialFn;
  if (overrides.oauthEnv !== undefined) routeArgs.oauthEnv = overrides.oauthEnv;
  if (overrides.providerHealth !== undefined)
    routeArgs.providerHealth = overrides.providerHealth;
  if (overrides.listConnectedProviders !== undefined)
    routeArgs.listConnectedProviders = overrides.listConnectedProviders;
  const routes = createConnectionRoutes(routeArgs);
  return mountAs(routes);
}

describe("GET /oauth-configured", () => {
  test("reports true for a connector needing no client id, and for one whose client id is present", async () => {
    const app = buildApp({
      oauthEnv: { unconfiguredOauthConnectorClientId: "configured-id" },
    });
    const response = await app.request("/oauth-configured");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, boolean>;
    expect(body["no-client-id-needed-connector"]).toBe(true);
    expect(body["unconfigured-oauth-connector"]).toBe(true);
  });

  test("reports false for a connector whose client id is absent from the env bag", async () => {
    const app = buildApp();
    const response = await app.request("/oauth-configured");
    const body = (await response.json()) as Record<string, boolean>;
    expect(body["unconfigured-oauth-connector"]).toBe(false);
  });

  test("omits api-key and display-only connectors -- only oauth-bearing entries appear", async () => {
    const app = buildApp();
    const response = await app.request("/oauth-configured");
    const body = (await response.json()) as Record<string, boolean>;
    expect(body["accepting-connector"]).toBeUndefined();
    expect(body["display-only-connector"]).toBeUndefined();
  });
});

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

  test("a credentialInputKind: url connector stores the fixed placeholder secret and the URL as apiBaseUrl", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      "url-connector": {
        id: "url-connector",
        displayName: "URL Connector",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        credentialInputKind: "url",
        credentialPlaceholder: "http://localhost:11434",
        probe: async () => ({ ok: true }),
      },
    };
    let providerArgs: { apiBaseUrl?: string } | undefined;
    let credentialSecret: string | undefined;
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async (_api, _cookies, args) => {
        providerArgs = args;
        return "prv_1";
      },
      ensureCredentialFn: async (_api, _cookies, args) => {
        credentialSecret = args.secret;
        return "crd_1";
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/url-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "http://localhost:11434" }),
    });
    expect(response.status).toBe(200);
    expect(providerArgs?.apiBaseUrl).toBe("http://localhost:11434");
    expect(credentialSecret).toBe("ollama");
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

  test("a rejected probe reports the connector needs_attention with a category, never the probe's own message", async () => {
    const providerHealth = createProviderHealthStore();
    const app = buildApp({ providerHealth });
    const response = await app.request("/rejecting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    // The probe's own message is still the thing the person who just
    // typed the key sees in the 422 body...
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("the key was rejected");
    // ...but the provider-health record never carries it — only a closed
    // category the shell banner maps to fixed copy (CL-6092).
    const record = providerHealth.get(TENANT.id, "rejecting-connector");
    expect(record?.status).toBe("needs_attention");
    expect(record?.category).toBe("credential_failure");
    expect(record).not.toHaveProperty("reason");
    expect(record).not.toHaveProperty("message");
  });

  // A provider's rejection body is arbitrary prose that can carry a
  // request URL, an account id, or a key fragment — this proves that text
  // never reaches the stored record even when the probe's own message is
  // exactly that shape.
  test("a rejected probe whose message carries a URL and key fragment never stores that text", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      "url-laden-connector": {
        id: "url-laden-connector",
        displayName: "URL-laden Connector",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        probe: async () => ({
          ok: false,
          message:
            "https://api.example.test/v1/models?key=sk-live-abc123 rejected the request: invalid x-api-key",
        }),
      },
    };
    const providerHealth = createProviderHealthStore();
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      providerHealth,
    });
    const app = mountAs(routes);
    await app.request("/url-laden-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    const record = providerHealth.get(TENANT.id, "url-laden-connector");
    expect(record?.category).toBe("credential_failure");
    expect(JSON.stringify(record)).not.toContain("sk-live-abc123");
    expect(JSON.stringify(record)).not.toContain("https://");
  });

  test("a passing probe clears any needs_attention record for that connector", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report(
      TENANT.id,
      "accepting-connector",
      "credential_failure",
    );
    const app = buildApp({
      providerHealth,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
    });
    await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(
      providerHealth.get(TENANT.id, "accepting-connector"),
    ).toBeUndefined();
  });

  // CL-6092: a storage failure after a passing probe must never clear a
  // prior needs-attention record — the credential never actually became
  // durable, so the record should survive for the next attempt to see.
  test("a storage failure after a passing probe leaves a prior needs_attention record standing", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report(
      TENANT.id,
      "accepting-connector",
      "credential_failure",
    );
    const app = buildApp({
      providerHealth,
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
    expect(providerHealth.get(TENANT.id, "accepting-connector")?.status).toBe(
      "needs_attention",
    );
  });
});

describe("POST /:connectorId/credential/test provider health wiring", () => {
  test("a rejected probe reports the connector needs_attention", async () => {
    const providerHealth = createProviderHealthStore();
    const app = buildApp({ providerHealth });
    await app.request("/rejecting-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    const record = providerHealth.get(TENANT.id, "rejecting-connector");
    expect(record?.status).toBe("needs_attention");
    expect(record?.category).toBe("credential_failure");
  });

  test("a passing probe clears any needs_attention record for that connector", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report(
      TENANT.id,
      "accepting-connector",
      "credential_failure",
    );
    const app = buildApp({ providerHealth });
    await app.request("/accepting-connector/credential/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(
      providerHealth.get(TENANT.id, "accepting-connector"),
    ).toBeUndefined();
  });
});

describe("GET /provider-health", () => {
  test("reports every provider this tenant has marked needs_attention", async () => {
    const providerHealth = createProviderHealthStore(
      () => new Date("2026-08-15T00:00:00.000Z"),
    );
    providerHealth.report(TENANT.id, "anthropic", "credential_failure");
    const app = buildApp({ providerHealth });
    const response = await app.request("/provider-health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: Record<
        string,
        { status: string; category: string; at: string }
      >;
      connectedProviderCount?: number;
    };
    expect(body.providers["anthropic"]).toEqual({
      status: "needs_attention",
      category: "credential_failure",
      at: "2026-08-15T00:00:00.000Z",
    });
  });

  test("reports an empty providers object when nothing is unhealthy", async () => {
    const app = buildApp({ providerHealth: createProviderHealthStore() });
    const response = await app.request("/provider-health");
    const body = (await response.json()) as { providers: unknown };
    expect(body.providers).toEqual({});
  });

  test("reports an empty providers object when no store is configured", async () => {
    const app = buildApp();
    const response = await app.request("/provider-health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: unknown };
    expect(body.providers).toEqual({});
  });

  test("reports connectedProviderCount when the lister is configured", async () => {
    const app = buildApp({
      listConnectedProviders: async () => ["anthropic", "openai"],
    });
    const response = await app.request("/provider-health");
    const body = (await response.json()) as { connectedProviderCount: number };
    expect(body.connectedProviderCount).toBe(2);
  });

  test("omits connectedProviderCount when no lister is configured", async () => {
    const app = buildApp();
    const response = await app.request("/provider-health");
    const body = (await response.json()) as Record<string, unknown>;
    expect("connectedProviderCount" in body).toBe(false);
  });
});
