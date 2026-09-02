// Exercises `createConnectionRoutes`' HTTP surface: unknown connector,
// malformed body, the test route's pass/reject outcomes, and the
// complete route's storage handoff — mounted into a bare `Hono` with a
// tenant-injecting middleware, mirroring
// `packages/webhook-triggers/test/management-routes.test.ts`. A fake
// registry stands in for `CONNECTOR_REGISTRY` so every probe outcome is
// deterministic and nothing here ever touches the real network.
import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ModelInfo } from "@intx/types";
import type { ConnectorDescriptor } from "./descriptor";
import type { ApiCall } from "@corbits/hub-api-client";
import { createProviderHealthStore } from "./provider-health";
import { createConnectionRoutes, disconnectConnector } from "./routes";

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

const USER = {
  id: "user_alice",
  createdAt: new Date(),
  updatedAt: new Date(),
  email: "alice@example.test",
  emailVerified: true,
  name: "Alice",
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
    c.set("user", USER);
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
    seedCatalogFn?: Parameters<
      typeof createConnectionRoutes
    >[0]["seedCatalogFn"];
    disconnectConnectorFn?: Parameters<
      typeof createConnectionRoutes
    >[0]["disconnectConnectorFn"];
    oauthEnv?: Readonly<Record<string, string | undefined>>;
    providerHealth?: Parameters<
      typeof createConnectionRoutes
    >[0]["providerHealth"];
    listConnectedProviders?: Parameters<
      typeof createConnectionRoutes
    >[0]["listConnectedProviders"];
    onConnected?: Parameters<typeof createConnectionRoutes>[0]["onConnected"];
    onInferenceCredentialUsable?: Parameters<
      typeof createConnectionRoutes
    >[0]["onInferenceCredentialUsable"];
    getResolvedCatalogFn?: Parameters<
      typeof createConnectionRoutes
    >[0]["getResolvedCatalogFn"];
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
  if (overrides.seedCatalogFn !== undefined)
    routeArgs.seedCatalogFn = overrides.seedCatalogFn;
  if (overrides.disconnectConnectorFn !== undefined)
    routeArgs.disconnectConnectorFn = overrides.disconnectConnectorFn;
  if (overrides.oauthEnv !== undefined) routeArgs.oauthEnv = overrides.oauthEnv;
  if (overrides.providerHealth !== undefined)
    routeArgs.providerHealth = overrides.providerHealth;
  if (overrides.listConnectedProviders !== undefined)
    routeArgs.listConnectedProviders = overrides.listConnectedProviders;
  if (overrides.onConnected !== undefined)
    routeArgs.onConnected = overrides.onConnected;
  if (overrides.onInferenceCredentialUsable !== undefined)
    routeArgs.onInferenceCredentialUsable =
      overrides.onInferenceCredentialUsable;
  if (overrides.getResolvedCatalogFn !== undefined)
    routeArgs.getResolvedCatalogFn = overrides.getResolvedCatalogFn;
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

  test("CL-6403: probeBaseUrls threads a fake server's origin into the probe and the stored provider row", async () => {
    let probedBaseUrl: string | undefined;
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      github: {
        id: "github",
        displayName: "GitHub",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: ["@corbits/github-tools"],
        probe: async (_apiKey, opts) => {
          probedBaseUrl = opts?.baseUrl;
          return { ok: true };
        },
      },
    };
    let providerArgs: { apiBaseUrl?: string } | undefined;
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      probeBaseUrls: { github: "http://fake-github.test" },
      ensureProviderFn: async (_api, _cookies, args) => {
        providerArgs = args;
        return "prv_1";
      },
      ensureCredentialFn: async () => "crd_1",
    });
    const app = mountAs(routes);
    const response = await app.request("/github/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "pat-value" }),
    });
    expect(response.status).toBe(200);
    expect(probedBaseUrl).toBe("http://fake-github.test");
    expect(providerArgs?.apiBaseUrl).toBe("http://fake-github.test");
  });

  test("a connector absent from probeBaseUrls gets no baseUrl override", async () => {
    let probedOpts: { baseUrl?: string } | undefined;
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      "accepting-connector": {
        id: "accepting-connector",
        displayName: "Accepting Connector",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        probe: async (_apiKey, opts) => {
          probedOpts = opts;
          return { ok: true };
        },
      },
    };
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      probeBaseUrls: { github: "http://fake-github.test" },
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
    });
    const app = mountAs(routes);
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(200);
    expect(probedOpts).toBeUndefined();
  });

  test("connecting an inference provider seeds its catalog with the proved key", async () => {
    // "anthropic" is a real `PROVIDER_TEST_CONFIG` key, so
    // `isInferenceProvider` recognizes it -- unlike `accepting-connector`
    // above, which is a fake id `PROVIDER_TEST_CONFIG` has never heard of.
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      anthropic: {
        id: "anthropic",
        displayName: "Anthropic",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        probe: async () => ({ ok: true }),
      },
    };
    const seedCatalogCalls: unknown[] = [];
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/anthropic/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-good" }),
    });
    expect(response.status).toBe(200);
    expect(seedCatalogCalls).toHaveLength(1);
    const args = seedCatalogCalls[0] as {
      provider: string;
      apiKey: string;
      credentialVerified: boolean;
      baseURLOverride?: string;
    };
    expect(args.provider).toBe("anthropic");
    expect(args.apiKey).toBe("sk-ant-good");
    expect(args.credentialVerified).toBe(true);
    expect(args.baseURLOverride).toBeUndefined();
  });

  test("connecting Ollama seeds its catalog with baseURLOverride and the placeholder secret", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      ollama: {
        id: "ollama",
        displayName: "Ollama",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        credentialInputKind: "url",
        credentialPlaceholder: "http://localhost:11434",
        probe: async () => ({ ok: true }),
      },
    };
    const seedCatalogCalls: unknown[] = [];
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "https://home-mac-studio.tail87f5aa.ts.net",
      }),
    });
    expect(response.status).toBe(200);
    expect(seedCatalogCalls).toHaveLength(1);
    const args = seedCatalogCalls[0] as {
      provider: string;
      apiKey: string;
      baseURLOverride?: string;
    };
    expect(args.provider).toBe("ollama");
    expect(args.baseURLOverride).toBe(
      "https://home-mac-studio.tail87f5aa.ts.net",
    );
    // Ollama has no auth layer of its own -- the fixed placeholder
    // secret is what gets stored/seeded, never the URL itself.
    expect(args.apiKey).toBe("ollama");
    const body = (await response.json()) as { modelGuidance?: string };
    expect(body.modelGuidance).toBeUndefined();
  });

  test("CL-6351: connecting Ollama with only an embedding model installed surfaces guided model guidance, never a bare success", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      ollama: {
        id: "ollama",
        displayName: "Ollama",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        credentialInputKind: "url",
        credentialPlaceholder: "http://localhost:11434",
        probe: async () => ({ ok: true }),
      },
    };
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => ({ hasCompletionCapableModel: false }),
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "http://localhost:11434" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      modelGuidance?: string;
    };
    expect(body.status).toBe("active");
    expect(body.modelGuidance).toBe(
      "Ollama is connected, but no chat model is installed — run `ollama pull qwen3` and try again.",
    );
  });

  test("CL-6351: connecting Ollama with a chat-capable model installed never surfaces model guidance", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      ollama: {
        id: "ollama",
        displayName: "Ollama",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        credentialInputKind: "url",
        credentialPlaceholder: "http://localhost:11434",
        probe: async () => ({ ok: true }),
      },
    };
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "http://localhost:11434" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      modelGuidance?: string;
    };
    expect(body.status).toBe("active");
    expect(body.modelGuidance).toBeUndefined();
  });

  test("connecting a non-inference connector never seeds a catalog", async () => {
    const seedCatalogCalls: unknown[] = [];
    const app = buildApp({
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(200);
    expect(seedCatalogCalls).toHaveLength(0);
  });

  test("a catalog seed failure 500s with an honest error and never confirms connected", async () => {
    const registry: Readonly<Record<string, ConnectorDescriptor>> = {
      ...FAKE_REGISTRY,
      anthropic: {
        id: "anthropic",
        displayName: "Anthropic",
        authKind: "api-key",
        credentialPlugin: "http",
        docsUrl: "https://example.test/docs",
        feedsTools: [],
        probe: async () => ({ ok: true }),
      },
    };
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => {
        throw new Error("hub unreachable while seeding catalog");
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/anthropic/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-good" }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("connection_setup_failed");
  });

  test("a storage failure after a good probe 500s and reports without leaking the key", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
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
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "persist_api_key_connection",
      extra: { connectorId: "accepting-connector" },
    });
    const extra = report.mock.calls[0]?.[1]?.extra as
      Record<string, unknown> | undefined;
    expect(JSON.stringify(extra)).not.toContain("good-key");
    report.mockRestore();
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
    const body = (await response.json()) as { error: { userMessage: string } };
    expect(body.error.userMessage).toBe("the key was rejected");
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

// A fake `ApiCall` for `disconnectConnector` itself: unlike the route
// tests above (which stub the whole function), these exercise the real
// cleanup ordering against a scripted native-hub double, the same
// `fakeAPI`-style pattern `packages/hub-client/test/helpers.ts` uses for
// `ensureProvider`/`ensureCredential`/`seedCatalog`.
type FakeCall = {
  readonly method: string;
  readonly path: string;
};

function page(data: readonly unknown[]) {
  return { status: 200, data: { data, nextCursor: null } };
}

const STAMP = "2026-01-01T00:00:00.000Z";

function catalogProviderRow(id: string, name: string) {
  return {
    id,
    tenantId: "tnt_1",
    name,
    plugin: "anthropic",
    baseURL: "https://api.anthropic.com",
    credentialId: "crd_1",
    disabled: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function providerRow(id: string, name: string) {
  return {
    id,
    tenantId: "tnt_1",
    name,
    plugin: "http",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function fakeDisconnectAPI(
  handler: (call: FakeCall) => { status: number; data: unknown } | undefined,
): { api: ApiCall; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const api: ApiCall = async (method, path) => {
    calls.push({ method, path });
    const response = handler({ method, path });
    if (response === undefined) {
      throw new Error(`unexpected hub call in test: ${method} ${path}`);
    }
    return { status: response.status, data: response.data, cookies: [] };
  };
  return { api, calls };
}

describe("disconnectConnector", () => {
  const TENANT_ID = "tnt_1";

  test("an inference connector (catalog provider present) deletes the catalog provider before the credential provider, cascading offerings", async () => {
    const { api, calls } = fakeDisconnectAPI(({ method, path }) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return page([catalogProviderRow("mprv_1", "anthropic")]);
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers/mprv_1`
      ) {
        return { status: 204, data: null };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return page([providerRow("prv_1", "anthropic")]);
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/providers/prv_1`
      ) {
        return { status: 204, data: null };
      }
      return undefined;
    });

    const result = await disconnectConnector(
      api,
      [],
      { tenantId: TENANT_ID, connectorId: "anthropic" },
      () => {},
    );

    expect(result.disconnected).toBe(true);
    const catalogDeleteIndex = calls.findIndex(
      (call) =>
        call.path === `/api/tenants/${TENANT_ID}/catalog/providers/mprv_1`,
    );
    const providerDeleteIndex = calls.findIndex(
      (call) => call.path === `/api/tenants/${TENANT_ID}/providers/prv_1`,
    );
    expect(catalogDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(providerDeleteIndex).toBeGreaterThan(catalogDeleteIndex);
  });

  test("a non-inference (MCP-style) connector with no catalog provider still removes its provider row", async () => {
    const { api } = fakeDisconnectAPI(({ method, path }) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return page([]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return page([providerRow("prv_exa", "exa")]);
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/providers/prv_exa`
      ) {
        return { status: 204, data: null };
      }
      return undefined;
    });

    const result = await disconnectConnector(
      api,
      [],
      { tenantId: TENANT_ID, connectorId: "exa" },
      () => {},
    );

    expect(result.disconnected).toBe(true);
  });

  test("a connector with no provider row at all reports not disconnected, without attempting a delete", async () => {
    const { api, calls } = fakeDisconnectAPI(({ method, path }) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return page([]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return page([]);
      }
      return undefined;
    });

    const result = await disconnectConnector(
      api,
      [],
      { tenantId: TENANT_ID, connectorId: "never-connected" },
      () => {},
    );

    expect(result.disconnected).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("a concurrent disconnect (catalog provider DELETE 404s because a first call already removed it) resolves instead of throwing", async () => {
    const { api } = fakeDisconnectAPI(({ method, path }) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return page([catalogProviderRow("mprv_1", "anthropic")]);
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers/mprv_1`
      ) {
        return { status: 404, data: { error: { code: "not_found" } } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return page([]);
      }
      return undefined;
    });

    const result = await disconnectConnector(
      api,
      [],
      { tenantId: TENANT_ID, connectorId: "anthropic" },
      () => {},
    );

    expect(result.disconnected).toBe(false);
  });

  test("a concurrent disconnect (provider DELETE 404s because a first call already removed it) resolves instead of throwing", async () => {
    const { api } = fakeDisconnectAPI(({ method, path }) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return page([]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return page([providerRow("prv_1", "anthropic")]);
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/providers/prv_1`
      ) {
        return { status: 404, data: { error: { code: "not_found" } } };
      }
      return undefined;
    });

    const result = await disconnectConnector(
      api,
      [],
      { tenantId: TENANT_ID, connectorId: "anthropic" },
      () => {},
    );

    expect(result.disconnected).toBe(false);
  });
});

describe("DELETE /:connectorId/disconnect", () => {
  test("unknown connector 404s", async () => {
    const app = buildApp();
    const response = await app.request("/not-a-connector/disconnect", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  test("a registered connector with nothing to disconnect 404s", async () => {
    const app = buildApp({
      disconnectConnectorFn: async () => ({ disconnected: false }),
    });
    const response = await app.request("/accepting-connector/disconnect", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  test("a successful disconnect 204s with no body", async () => {
    const app = buildApp({
      disconnectConnectorFn: async () => ({ disconnected: true }),
    });
    const response = await app.request("/accepting-connector/disconnect", {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
  });

  test("a cleanup failure 500s rather than leaving the client guessing", async () => {
    const app = buildApp({
      disconnectConnectorFn: async () => {
        throw new Error("the hub rejected the catalog provider delete");
      },
    });
    const response = await app.request("/accepting-connector/disconnect", {
      method: "DELETE",
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("disconnect_failed");
  });
});

describe("onConnected hook", () => {
  test("a stored API key fires onConnected with the connected tenant and connector", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      onConnected: async (info) => {
        events.push(info);
      },
    });
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });
    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        tenantId: TENANT.id,
        principalId: PRINCIPAL.id,
        connectorId: "accepting-connector",
        displayName: "Accepting Connector",
      },
    ]);
  });

  test("a rejected key never fires onConnected", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      onConnected: async (info) => {
        events.push(info);
      },
    });
    const response = await app.request("/rejecting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad-key" }),
    });
    expect(response.status).toBe(422);
    expect(events).toHaveLength(0);
  });
});

function modelWithOfferings(offeringCount: number): ModelInfo {
  return {
    id: "model_1",
    canonicalName: "qwen3",
    displayName: "Qwen3",
    offerings: Array.from({ length: offeringCount }, (_, index) => ({
      offeringId: `off_${index}`,
      providerId: "prov_1",
      providerName: "ollama",
      plugin: "ollama",
      priority: index,
      capabilities: [],
    })),
  } as unknown as ModelInfo;
}

describe("onInferenceCredentialUsable hook", () => {
  const OLLAMA_REGISTRY: Readonly<Record<string, ConnectorDescriptor>> = {
    ...FAKE_REGISTRY,
    ollama: {
      id: "ollama",
      displayName: "Ollama",
      authKind: "api-key",
      credentialPlugin: "http",
      docsUrl: "https://example.test/docs",
      feedsTools: [],
      credentialInputKind: "url",
      credentialPlaceholder: "http://localhost:11434",
      probe: async () => ({ ok: true }),
    },
  };

  test("a connected provider that resolves a usable model fires the hook with that provider's own key and endpoint", async () => {
    const events: unknown[] = [];
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry: OLLAMA_REGISTRY,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
      getResolvedCatalogFn: async () => [modelWithOfferings(1)],
      onInferenceCredentialUsable: async (info) => {
        events.push(info);
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "https://home-mac-studio.tail87f5aa.ts.net",
      }),
    });

    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        userId: USER.id,
        tenantId: TENANT.id,
        tenantDomain: TENANT.domain,
        principalId: PRINCIPAL.id,
        provider: "ollama",
        apiKey: "ollama",
        baseURLOverride: "https://home-mac-studio.tail87f5aa.ts.net",
      },
    ]);
  });

  test("a connected provider that resolves no usable model never fires the hook — a seeded row is not the same as a usable one", async () => {
    const events: unknown[] = [];
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry: OLLAMA_REGISTRY,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => ({ hasCompletionCapableModel: false }),
      getResolvedCatalogFn: async () => [modelWithOfferings(0)],
      onInferenceCredentialUsable: async (info) => {
        events.push(info);
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "http://localhost:11434" }),
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  test("a non-inference connector never fires the hook", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      onInferenceCredentialUsable: async (info) => {
        events.push(info);
      },
    });
    const response = await app.request("/accepting-connector/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "good-key" }),
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  test("a resolved-catalog check failure is reported and never breaks the connect", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const events: unknown[] = [];
    const routes = createConnectionRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      registry: OLLAMA_REGISTRY,
      ensureProviderFn: async () => "prv_1",
      ensureCredentialFn: async () => "crd_1",
      seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
      getResolvedCatalogFn: async () => {
        throw new Error("hub unreachable");
      },
      onInferenceCredentialUsable: async (info) => {
        events.push(info);
      },
    });
    const app = mountAs(routes);
    const response = await app.request("/ollama/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "https://home-mac-studio.tail87f5aa.ts.net",
      }),
    });

    expect(response.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "check_resolved_catalog_after_connect",
      tenantId: TENANT.id,
      extra: { connectorId: "ollama" },
    });
    report.mockRestore();
  });
});
