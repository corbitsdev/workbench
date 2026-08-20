// Proves `createTenantConnectCredential` end to end through the actual
// `createOAuthConnectRoutes` mount apps/hub uses (CL-6389): a full
// authorize -> callback -> credential-stored round trip against a fake
// provider (mirroring `oauth-routes.test.ts`'s `fakeDescriptor`), and a
// mismatched-state callback that must never reach persistence at all.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createNoopCredentialCipher } from "@intx/crypto";
import type { ConnectorDescriptor } from "./descriptor";
import { createOAuthConnectRoutes } from "./oauth-routes";
import { createTenantConnectCredential } from "./oauth-tenant-connect";
import { createProviderHealthStore } from "./provider-health";

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

const WIDGET_CONNECTOR: ConnectorDescriptor = {
  id: "widget",
  displayName: "Widget",
  authKind: "oauth-pkce",
  docsUrl: "https://widget.example.com",
  credentialPlugin: "http",
  feedsTools: [],
  oauth: {
    authorizeUrl: "https://widget.example.com/authorize",
    usesPKCE: true,
    echoesState: false,
    deploysDefaultWorkflows: false,
    buildAuthorizeUrl: ({ callbackUrl, codeChallenge }) => {
      const url = new URL("https://widget.example.com/authorize");
      url.searchParams.set("redirect_uri", callbackUrl);
      if (codeChallenge !== undefined) {
        url.searchParams.set("code_challenge", codeChallenge);
      }
      return url;
    },
    // Stands in for the fake provider's own token endpoint.
    exchange: async ({ code }) => ({ ok: true, apiKey: `key-for-${code}` }),
  },
};

function mountTenantScoped(
  overrides: Parameters<typeof createTenantConnectCredential>[0] = {
    hubUrl: "https://bench.example.com",
    log: () => undefined,
  },
): {
  app: Hono<TenantEnv>;
  providers: { tenantId: string; name: string; plugin: string }[];
  credentials: { tenantId: string; providerId: string; secret: string }[];
} {
  const providers: { tenantId: string; name: string; plugin: string }[] = [];
  const credentials: {
    tenantId: string;
    providerId: string;
    secret: string;
  }[] = [];

  const connectCredential = createTenantConnectCredential({
    ...overrides,
    registry: { widget: WIDGET_CONNECTOR },
    ensureProviderFn: async (_api, _cookies, args) => {
      providers.push({
        tenantId: args.tenantId,
        name: args.name,
        plugin: args.plugin,
      });
      return `prv_${args.name}`;
    },
    ensureCredentialFn: async (_api, _cookies, args) => {
      credentials.push({
        tenantId: args.tenantId,
        providerId: args.providerId,
        secret: args.secret,
      });
      return `cred_${args.providerId}`;
    },
  });

  const routes = createOAuthConnectRoutes({
    hubUrl: "https://bench.example.com",
    log: () => undefined,
    credentialCipher: createNoopCredentialCipher(),
    registry: { widget: WIDGET_CONNECTOR },
    connectCredential,
  });

  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("user", {
      id: "user_1",
      email: "user_1@example.com",
    } as never);
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/api/tenants/tnt_1/connections/oauth", routes);
  return { app, providers, credentials };
}

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((sc) => sc.split(";")[0])
    .join("; ");
}

describe("createTenantConnectCredential, mounted through createOAuthConnectRoutes", () => {
  test("full authorize -> callback -> credential-stored round trip", async () => {
    const { app, providers, credentials } = mountTenantScoped();

    const started = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/start",
    );
    expect(started.status).toBe(302);
    const authorizeUrl = new URL(started.headers.get("location") ?? "");
    expect(authorizeUrl.origin).toBe("https://widget.example.com");
    const cookie = cookieHeaderFrom(started);

    const callback = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(
      callback.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("connected");
    expect(redirect.searchParams.get("tenantSlug")).toBe(TENANT.slug);

    expect(providers).toEqual([
      { tenantId: TENANT.id, name: "widget", plugin: "http" },
    ]);
    expect(credentials).toEqual([
      {
        tenantId: TENANT.id,
        providerId: "prv_widget",
        secret: "key-for-abc123",
      },
    ]);
  });

  test("a callback with no matching state never persists a credential", async () => {
    const { app, providers, credentials } = mountTenantScoped();

    const callback = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/callback?code=abc123&state=forged",
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(
      callback.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(providers).toEqual([]);
    expect(credentials).toEqual([]);
  });

  test("a tampered state cookie is rejected before anything is persisted", async () => {
    const { app, providers, credentials } = mountTenantScoped();

    const started = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/start",
    );
    // Same cookie *name*, garbage value: fails the sealed-state cipher
    // check the same way a forged or replayed cookie would, matching
    // the factory's own cross-user regression coverage in
    // oauth-routes.test.ts.
    const cookie = cookieHeaderFrom(started).replace(
      /workbench_widget_connect=[^;]+/,
      "workbench_widget_connect=not-a-real-sealed-state",
    );

    const callback = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(
      callback.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(providers).toEqual([]);
    expect(credentials).toEqual([]);
  });

  test("provider-health clears on a successful connect", async () => {
    const providerHealth = createProviderHealthStore();
    providerHealth.report(TENANT.id, "widget", "credential_failure");
    expect(providerHealth.listForTenant(TENANT.id)["widget"]).toBeDefined();

    const { app } = mountTenantScoped({
      hubUrl: "https://bench.example.com",
      log: () => undefined,
      providerHealth,
    });

    const started = await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/start",
    );
    const cookie = cookieHeaderFrom(started);
    await app.request(
      "/api/tenants/tnt_1/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );

    expect(providerHealth.listForTenant(TENANT.id)["widget"]).toBeUndefined();
  });
});
