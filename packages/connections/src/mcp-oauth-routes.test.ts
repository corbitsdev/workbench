// Route-level tests for the MCP-server OAuth connect flow, exercised
// against a real loopback HTTP authorization server that answers RFC
// 9728 protected-resource metadata, RFC 8414 authorization-server
// metadata, RFC 7591 dynamic client registration, and the authorize/token
// endpoints -- proving the official SDK's `auth()` orchestrator this
// factory drives actually completes discovery → DCR → PKCE → token
// exchange end to end. The post-auth MCP handshake itself is stubbed via
// `deps.probe` (the same test seam `mcp-server-routes.test.ts` uses),
// since this suite is about the OAuth mechanics, not a second proof that
// `@corbits/mcp-tools`' transport works.
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createNoopCredentialCipher } from "@intx/crypto";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ApiCall } from "@workbench/hub-client";
import { createMcpOAuthRoutes } from "./mcp-oauth-routes";
import { mcpPresetBySlug } from "./mcp-presets";
import type { McpProbeResult } from "./mcp-probe";

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

/** A minimal, real HTTP authorization server: RFC 9728 protected-resource
 * metadata, RFC 8414 authorization-server metadata, RFC 7591 dynamic
 * client registration, an authorize endpoint that auto-approves (no real
 * consent UI to drive in a test), and a token endpoint that only accepts
 * the exact `code_verifier` PKCE minted. `tokenGrant` controls whether the
 * token response also issues a refresh token — an authorization server
 * that doesn't (the Hugging-Face-precedent case) is the default. */
function startStubAuthorizationServer(
  tokenGrant: {
    refreshToken?: string;
    expiresIn?: number;
    /** CL-6371 red-path fixture: a provider that never echoes `state`
     * back on the authorize redirect, even though we sent one. */
    echoState?: boolean;
  } = {},
): {
  origin: string;
  resourcePath: string;
  stop: () => void;
  issuedCodes: Map<string, { codeChallenge: string; clientId: string }>;
  registrationBodies: unknown[];
} {
  const issuedCodes = new Map<
    string,
    { codeChallenge: string; clientId: string }
  >();
  const registrationBodies: unknown[] = [];
  let nextClientId = 1;
  const clients = new Map<string, { redirectUris: string[] }>();

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const origin = `http://localhost:${server.port}`;

      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const body: unknown = await req.json();
        registrationBodies.push(body);
        const redirectUris = (body as { redirect_uris: string[] })
          .redirect_uris;
        const clientId = `client_${nextClientId++}`;
        clients.set(clientId, { redirectUris });
        return Response.json({
          client_id: clientId,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const clientId = url.searchParams.get("client_id") ?? "";
        const code = `code_${crypto.randomUUID()}`;
        issuedCodes.set(code, { codeChallenge, clientId });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        if (tokenGrant.echoState !== false) {
          redirect.searchParams.set("state", state);
        }
        return Response.redirect(redirect.toString(), 302);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = await req.formData();
        const code = String(form.get("code") ?? "");
        const codeVerifier = String(form.get("code_verifier") ?? "");
        const issued = issuedCodes.get(code);
        if (issued === undefined) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(codeVerifier),
        );
        const recomputedChallenge = Buffer.from(digest)
          .toString("base64")
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "");
        if (recomputedChallenge !== issued.codeChallenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: `token_for_${code}`,
          token_type: "bearer",
          ...(tokenGrant.refreshToken !== undefined
            ? { refresh_token: tokenGrant.refreshToken }
            : {}),
          ...(tokenGrant.expiresIn !== undefined
            ? { expires_in: tokenGrant.expiresIn }
            : {}),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    resourcePath: `http://localhost:${server.port}/mcp`,
    stop: () => server.stop(true),
    issuedCodes,
    registrationBodies,
  };
}

function fakeHub() {
  const providers: {
    id: string;
    tenantId: string;
    name: string;
    plugin: string;
    apiBaseUrl?: string;
    createdAt: string;
    updatedAt: string;
  }[] = [];
  const credentials: {
    id: string;
    tenantId: string;
    providerId: string;
    name: string;
    type: "api_key" | "oauth_token";
    secret: string;
    refreshSecret?: string;
    expiresAt?: string;
    status: "active";
    createdAt: string;
    updatedAt: string;
  }[] = [];
  let nextId = 1;

  const apiCall: ApiCall = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/providers?inherited=false")) {
      return {
        status: 200,
        data: { data: providers, nextCursor: null },
        cookies: [],
      };
    }
    if (method === "GET" && path.endsWith("/credentials")) {
      return {
        status: 200,
        data: { data: credentials, nextCursor: null },
        cookies: [],
      };
    }
    if (method === "POST" && path.endsWith("/providers")) {
      const input = body as {
        name: string;
        plugin: string;
        apiBaseUrl?: string;
      };
      const row = {
        id: `prv_${nextId++}`,
        tenantId: TENANT.id,
        name: input.name,
        plugin: input.plugin,
        ...(input.apiBaseUrl !== undefined
          ? { apiBaseUrl: input.apiBaseUrl }
          : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      providers.push(row);
      return { status: 201, data: row, cookies: [] };
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      const input = body as {
        providerId: string;
        name: string;
        secret: string;
        type: "api_key" | "oauth_token";
        refreshSecret?: string;
        expiresAt?: string;
      };
      const row = {
        id: `crd_${nextId++}`,
        tenantId: TENANT.id,
        providerId: input.providerId,
        name: input.name,
        type: input.type,
        secret: input.secret,
        ...(input.refreshSecret !== undefined
          ? { refreshSecret: input.refreshSecret }
          : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt }
          : {}),
        status: "active" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      credentials.push(row);
      return { status: 201, data: row, cookies: [] };
    }
    throw new Error(`unhandled fake hub call: ${method} ${path}`);
  };

  return { apiCall, providers, credentials };
}

/** Drives `/start` → the stub authorization server's auto-approved
 * `/authorize` → `/callback`, returning the callback's response. Shared by
 * every test that needs a completed connect, not just the ones asserting
 * on the redirect itself. */
async function runConnectFlow(
  app: Hono<TenantEnv>,
  as: { origin: string; resourcePath: string },
): Promise<Response> {
  const startResponse = await app.request(
    `/exa/start?url=${encodeURIComponent(as.resourcePath)}&name=Exa`,
    { redirect: "manual" },
  );
  const cookieHeader = startResponse.headers.get("set-cookie") ?? "";
  const cookie = cookieHeader.split(";")[0] ?? "";
  const authorizeLocation = startResponse.headers.get("location") ?? "";

  const authorizeResponse = await fetch(authorizeLocation, {
    redirect: "manual",
  });
  const redirectToCallback = authorizeResponse.headers.get("location") ?? "";
  const callbackUrl = new URL(redirectToCallback);

  return app.request(`${callbackUrl.pathname}${callbackUrl.search}`, {
    headers: { cookie },
    redirect: "manual",
  });
}

describe("MCP OAuth connect flow", () => {
  test("start discovers the authorization server and redirects there with PKCE + a registered client", async () => {
    const as = startStubAuthorizationServer();
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
      });
      const app = mountAs(routes);

      const response = await app.request(
        `/exa/start?url=${encodeURIComponent(as.resourcePath)}&name=Exa`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith(`${as.origin}/authorize`)).toBe(true);
      const params = new URL(location).searchParams;
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("client_id")).not.toBeNull();
      // CL-6371: the authorize URL must carry a CSRF-binding `state` --
      // omitting it is what made PostHog's real MCP authorization server
      // reject the redirect with "Missing state parameter."
      expect(params.get("state")).not.toBeNull();
      expect(params.get("state")).not.toBe("");
      expect(response.headers.get("set-cookie") ?? "").toContain(
        "workbench_mcp_oauth_exa=",
      );
      expect(as.registrationBodies).toHaveLength(1);
      const dcrBody = as.registrationBodies[0];
      expect(
        dcrBody !== null && typeof dcrBody === "object" && "scope" in dcrBody,
      ).toBe(false);
    } finally {
      as.stop();
    }
  });

  test("preset Canva start posts the 16 space-joined scopes on the RFC 7591 DCR body", async () => {
    const as = startStubAuthorizationServer();
    const originalFetch = globalThis.fetch;
    const canvaOrigin = "https://mcp.canva.com";
    // `/canva/start` with no `?url=` discovers the preset origin. Rewrite
    // that host onto the stub AS (and rewrite advertised origins back) so
    // this stays a loopback test while still exercising the no-override
    // path that actually joins `preset.oauthScopes`.
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const href =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!href.startsWith(canvaOrigin)) {
          return originalFetch(input, init);
        }
        const rewritten = href.replace(canvaOrigin, as.origin);
        const response =
          input instanceof Request
            ? await originalFetch(new Request(rewritten, input), init)
            : await originalFetch(rewritten, init);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("json")) {
          return response;
        }
        const body = (await response.text()).replaceAll(as.origin, canvaOrigin);
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
      originalFetch,
    );
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
      });
      const app = mountAs(routes);

      const response = await app.request("/canva/start", {
        redirect: "manual",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith(`${canvaOrigin}/authorize`)).toBe(true);
      expect(as.registrationBodies).toHaveLength(1);
      const canvaScopes = mcpPresetBySlug("canva")?.oauthScopes;
      expect(canvaScopes).toHaveLength(16);
      const dcrBody = as.registrationBodies[0];
      expect(dcrBody).toEqual(
        expect.objectContaining({
          scope: canvaScopes?.join(" "),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      as.stop();
    }
  });

  test("callback completes the token exchange and stores a bearer credential", async () => {
    const as = startStubAuthorizationServer();
    try {
      const hub = fakeHub();
      let probedToken: string | undefined;
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (_url, token): Promise<McpProbeResult> => {
          probedToken = token;
          return { ok: true, toolCount: 5 };
        },
      });
      const app = mountAs(routes);

      const callbackResponse = await runConnectFlow(app, as);

      expect(callbackResponse.status).toBe(302);
      const finalLocation = callbackResponse.headers.get("location") ?? "";
      expect(finalLocation).toContain("outcome=connected");
      expect(probedToken).toBeDefined();
      expect(probedToken).toMatch(/^token_for_code_/);
      expect(hub.providers).toHaveLength(1);
      expect(hub.providers[0]?.name).toBe("mcp:exa");
      // Same credential plugin as the API-key connect path — the plain
      // "http" plugin can't deliver MCP credentials to runs.
      expect(hub.providers[0]?.plugin).toBe("mcp-streamable-http");
      expect(hub.credentials).toHaveLength(1);
      expect(hub.credentials[0]?.secret).toBe(probedToken);
    } finally {
      as.stop();
    }
  });

  test("callback stores an oauth_token credential with the issued refresh token and expiry", async () => {
    const as = startStubAuthorizationServer({
      refreshToken: "refresh_abc123",
      expiresIn: 3600,
    });
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 3,
        }),
      });
      const app = mountAs(routes);

      const before = Date.now();
      const callbackResponse = await runConnectFlow(app, as);
      const after = Date.now();

      expect(callbackResponse.headers.get("location") ?? "").toContain(
        "outcome=connected",
      );
      expect(hub.credentials).toHaveLength(1);
      const stored = hub.credentials[0];
      expect(stored?.type).toBe("oauth_token");
      expect(stored?.refreshSecret).toBe("refresh_abc123");
      expect(stored?.expiresAt).toBeDefined();
      const expiresAtMs = new Date(stored?.expiresAt ?? "").getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 3600 * 1000);
    } finally {
      as.stop();
    }
  });

  test("callback stores no refreshSecret or expiresAt when the server issues no refresh token", async () => {
    const as = startStubAuthorizationServer();
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 3,
        }),
      });
      const app = mountAs(routes);

      const callbackResponse = await runConnectFlow(app, as);

      expect(callbackResponse.headers.get("location") ?? "").toContain(
        "outcome=connected",
      );
      expect(hub.credentials).toHaveLength(1);
      const stored = hub.credentials[0];
      expect(stored?.type).toBe("oauth_token");
      expect(stored?.refreshSecret).toBeUndefined();
      expect(stored?.expiresAt).toBeUndefined();
    } finally {
      as.stop();
    }
  });

  test("an unknown slug with no url override redirects as an error", async () => {
    const hub = fakeHub();
    const routes = createMcpOAuthRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      credentialCipher: createNoopCredentialCipher(),
      apiCall: hub.apiCall,
    });
    const app = mountAs(routes);
    const response = await app.request("/not-a-preset/start", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/plugins?mcpOauth=not-a-preset&outcome=error&code=not_found",
    );
  });

  test("a preset that doesn't connect with OAuth is refused at start, not mid-dance", async () => {
    const hub = fakeHub();
    const routes = createMcpOAuthRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      credentialCipher: createNoopCredentialCipher(),
      apiCall: hub.apiCall,
    });
    const app = mountAs(routes);
    // github-mcp is a token preset (GitHub offers no dynamic client
    // registration) and exa is keyless — neither has an OAuth dance.
    for (const slug of ["github-mcp", "exa"]) {
      const response = await app.request(`/${slug}/start`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/plugins?mcpOauth=${slug}&outcome=error&code=bad_request`,
      );
    }
  });

  test("CL-6371: a provider that echoes state back completes the round trip", async () => {
    const as = startStubAuthorizationServer({ echoState: true });
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 1,
        }),
      });
      const app = mountAs(routes);

      const callbackResponse = await runConnectFlow(app, as);

      expect(callbackResponse.status).toBe(302);
      expect(callbackResponse.headers.get("location") ?? "").toContain(
        "outcome=connected",
      );
    } finally {
      as.stop();
    }
  });

  test("CL-6371: a provider that omits state we sent is rejected as a CSRF failure, not a raw error", async () => {
    const as = startStubAuthorizationServer({ echoState: false });
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 1,
        }),
      });
      const app = mountAs(routes);

      const callbackResponse = await runConnectFlow(app, as);

      expect(callbackResponse.status).toBe(302);
      const location = callbackResponse.headers.get("location") ?? "";
      expect(location).toContain("outcome=error");
      expect(location).toContain("code=state_mismatch");
      // The consumer envelope idiom (CL-6360): the redirect carries a
      // machine code the UI maps to copy, never the raw provider/SDK
      // error text.
      expect(location).not.toContain("Missing state parameter");
      expect(hub.credentials).toHaveLength(0);
    } finally {
      as.stop();
    }
  });

  test("a replayed callback is rejected as state_expired without a second exchange (one-shot state)", async () => {
    const as = startStubAuthorizationServer();
    try {
      const hub = fakeHub();
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 2,
        }),
      });
      const app = mountAs(routes);

      const startResponse = await app.request(
        `/exa/start?url=${encodeURIComponent(as.resourcePath)}&name=Exa`,
        { redirect: "manual" },
      );
      const cookieHeader = startResponse.headers.get("set-cookie") ?? "";
      const cookie = cookieHeader.split(";")[0] ?? "";
      const authorizeResponse = await fetch(
        startResponse.headers.get("location") ?? "",
        { redirect: "manual" },
      );
      const callbackUrl = new URL(
        authorizeResponse.headers.get("location") ?? "",
      );
      const replayableCallback = `${callbackUrl.pathname}${callbackUrl.search}`;

      const firstResponse = await app.request(replayableCallback, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(firstResponse.headers.get("location") ?? "").toContain(
        "outcome=connected",
      );

      // A browser (or an attacker holding a stolen state cookie)
      // presenting the exact same callback again: the sealed state was
      // burned by the first arrival, so the replay dies at the state
      // check — it never reaches the token endpoint a second time.
      const replayResponse = await app.request(replayableCallback, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(replayResponse.status).toBe(302);
      expect(replayResponse.headers.get("location") ?? "").toContain(
        "code=state_expired",
      );
      expect(hub.credentials).toHaveLength(1);
    } finally {
      as.stop();
    }
  });

  test("a callback with no cookie redirects with a state_expired error", async () => {
    const hub = fakeHub();
    const routes = createMcpOAuthRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      credentialCipher: createNoopCredentialCipher(),
      apiCall: hub.apiCall,
    });
    const app = mountAs(routes);
    const response = await app.request("/exa/callback?code=whatever", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain(
      "code=state_expired",
    );
  });
});

describe("onConnected hook", () => {
  test("a completed MCP OAuth connect fires onConnected with the stored slug", async () => {
    const as = startStubAuthorizationServer();
    try {
      const hub = fakeHub();
      const events: unknown[] = [];
      const routes = createMcpOAuthRoutes({
        hubUrl: "http://hub.test",
        requireGrant: allowAll,
        log: () => {},
        credentialCipher: createNoopCredentialCipher(),
        apiCall: hub.apiCall,
        probe: async (): Promise<McpProbeResult> => ({
          ok: true,
          toolCount: 3,
        }),
        onConnected: async (info) => {
          events.push(info);
        },
      });
      const app = mountAs(routes);

      const callbackResponse = await runConnectFlow(app, as);

      expect(callbackResponse.headers.get("location") ?? "").toContain(
        "outcome=connected",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: TENANT.id,
        principalId: PRINCIPAL.id,
      });
    } finally {
      as.stop();
    }
  });
});
