// CL-6394 regression: the hosted GitHub one-click connect, driven
// through the exact tenant-scoped start URL the UI now emits
// (`@corbits/settings-ui`'s `oauthStartHref` — its output is pinned
// literally in that package's own tests, and repeated literally here so
// the two suites cannot drift apart silently). Before the fix, the only
// UI entry point targeted `/api/onboarding/oauth/github/start`, whose
// mount binary-dispatched openrouter/huggingface and sent github into
// inference-only seeding — a TypeError on `CATALOG_SEEDS["github"]`
// AFTER a successful token exchange. This proves the full chain the UI
// actually drives: start → GitHub callback → token exchange (against a
// fake exchange server) → credential persisted, and — the crash's exact
// shape — no catalog seeding for a non-inference connector.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createNoopCredentialCipher } from "@intx/crypto";
import type {
  EnsureCredentialArgs,
  EnsureProviderArgs,
  SeedCatalogArgs,
} from "@corbits/seeding";
import type { ConnectorDescriptor } from "../src/descriptor";
import {
  exchangeCodeForGithubToken,
  GITHUB_TOKEN_EXCHANGE_URL,
} from "../src/github-connect";
import {
  createOAuthConnectRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
} from "../src/oauth-routes";
import { createTenantConnectCredential } from "../src/oauth-tenant-connect";
import { CONNECTOR_REGISTRY } from "../src/registry";

// What `oauthStartHref("tnt_1", "github", "/plugins")` renders into the
// plugins gallery's Connect link.
const UI_START_URL =
  "/api/tenants/tnt_1/connections/oauth/github/start?return=%2Fplugins";

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

function fakeGithubExchangeServer(exchangeBodies: unknown[]) {
  return async (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ): Promise<Response> => {
    expect(url).toBe(GITHUB_TOKEN_EXCHANGE_URL);
    exchangeBodies.push(JSON.parse(init.body));
    return Response.json({ access_token: "gho_exchanged_token" });
  };
}

function mountHubShaped() {
  const realGithub = CONNECTOR_REGISTRY["github"];
  if (realGithub?.oauth === undefined) {
    throw new Error("registry is missing the github oauth entry");
  }
  const exchangeBodies: unknown[] = [];
  // The real descriptor, with its exchange pointed at the fake GitHub
  // token server instead of github.com — same seam the descriptor's own
  // `fetchImpl` exposes.
  const github: ConnectorDescriptor = {
    ...realGithub,
    oauth: {
      ...realGithub.oauth,
      exchange: async ({ code, redirectUri, clientId, clientSecret }) => {
        if (clientId === undefined || clientSecret === undefined) {
          return { ok: false, message: "github app connect is not configured" };
        }
        const result = await exchangeCodeForGithubToken({
          code,
          redirectUri,
          clientId,
          clientSecret,
          fetchImpl: fakeGithubExchangeServer(exchangeBodies),
        });
        return result.ok ? { ok: true, apiKey: result.key } : result;
      },
    },
  };

  const providers: EnsureProviderArgs[] = [];
  const credentials: EnsureCredentialArgs[] = [];
  const seeds: SeedCatalogArgs[] = [];
  const routes = createOAuthConnectRoutes<TenantEnv>({
    hubUrl: "https://bench.example.com",
    log: () => undefined,
    credentialCipher: createNoopCredentialCipher(),
    registry: { github },
    oauthEnv: {
      githubAppClientId: "iv_client_id",
      githubAppClientSecret: "app-secret",
    },
    connectCredential: createTenantConnectCredential({
      hubUrl: "https://bench.example.com",
      log: () => undefined,
      registry: { github },
      ensureProviderFn: async (_api, _cookies, args) => {
        providers.push(args);
        return `prv_${args.name}`;
      },
      ensureCredentialFn: async (_api, _cookies, args) => {
        credentials.push(args);
        return `cred_${args.providerId}`;
      },
      seedCatalogFn: async (args) => {
        seeds.push(args);
        return { hasCompletionCapableModel: true };
      },
    }),
    defaultReturnPath: "/settings/connections",
    returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins"],
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
  return { app, providers, credentials, seeds, exchangeBodies };
}

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((sc) => sc.split(";")[0])
    .join("; ");
}

describe("hosted GitHub one-click connect through the UI's start URL", () => {
  test("start -> callback persists the exchanged token and lands back on /plugins", async () => {
    const { app, providers, credentials, seeds, exchangeBodies } =
      mountHubShaped();

    const started = await app.request(UI_START_URL);
    expect(started.status).toBe(302);
    const authorizeUrl = new URL(started.headers.get("location") ?? "");
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("iv_client_id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://bench.example.com/api/tenants/tnt_1/connections/oauth/github/callback",
    );
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    const cookie = cookieHeaderFrom(started);

    // GitHub echoes `state` back on the callback (echoesState: true).
    const callback = await app.request(
      `/api/tenants/tnt_1/connections/oauth/github/callback?code=gh_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(
      callback.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.pathname).toBe("/plugins");
    expect(redirect.searchParams.get("outcome")).toBe("connected");
    expect(redirect.searchParams.get("tenantSlug")).toBe(TENANT.slug);

    expect(exchangeBodies).toEqual([
      {
        client_id: "iv_client_id",
        client_secret: "app-secret",
        code: "gh_code_1",
        redirect_uri:
          "https://bench.example.com/api/tenants/tnt_1/connections/oauth/github/callback",
      },
    ]);
    expect(providers).toEqual([
      { tenantId: TENANT.id, name: "github", plugin: "http" },
    ]);
    expect(credentials).toEqual([
      {
        tenantId: TENANT.id,
        providerId: "prv_github",
        name: "GitHub",
        secret: "gho_exchanged_token",
        type: "api_key",
        verified: true,
      },
    ]);
    // The crash's exact shape: github has no catalog seed, so the
    // persist sequence must never reach seedCatalog for it.
    expect(seeds).toEqual([]);
  });
});
