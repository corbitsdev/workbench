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
 * the exact `code_verifier` PKCE minted. */
function startStubAuthorizationServer(): {
  origin: string;
  resourcePath: string;
  stop: () => void;
  issuedCodes: Map<string, { codeChallenge: string; clientId: string }>;
} {
  const issuedCodes = new Map<
    string,
    { codeChallenge: string; clientId: string }
  >();
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
        const body = (await req.json()) as { redirect_uris: string[] };
        const clientId = `client_${nextClientId++}`;
        clients.set(clientId, { redirectUris: body.redirect_uris });
        return Response.json({
          client_id: clientId,
          redirect_uris: body.redirect_uris,
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
        redirect.searchParams.set("state", state);
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
    type: "api_key";
    secret: string;
    status: "active";
    createdAt: string;
    updatedAt: string;
  }[] = [];
  let nextId = 1;

  const apiCall: ApiCall = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/providers?inherited=false")) {
      return { status: 200, data: { data: providers, nextCursor: null }, cookies: [] };
    }
    if (method === "GET" && path.endsWith("/credentials")) {
      return { status: 200, data: { data: credentials, nextCursor: null }, cookies: [] };
    }
    if (method === "POST" && path.endsWith("/providers")) {
      const input = body as { name: string; plugin: string; apiBaseUrl?: string };
      const row = {
        id: `prv_${nextId++}`,
        tenantId: TENANT.id,
        name: input.name,
        plugin: input.plugin,
        ...(input.apiBaseUrl !== undefined ? { apiBaseUrl: input.apiBaseUrl } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      providers.push(row);
      return { status: 201, data: row, cookies: [] };
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      const input = body as { providerId: string; name: string; secret: string };
      const row = {
        id: `crd_${nextId++}`,
        tenantId: TENANT.id,
        providerId: input.providerId,
        name: input.name,
        type: "api_key" as const,
        secret: input.secret,
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
      expect(response.headers.get("set-cookie") ?? "").toContain(
        "workbench_mcp_oauth_exa=",
      );
    } finally {
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

      const callbackResponse = await app.request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        { headers: { cookie }, redirect: "manual" },
      );

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

  test("an unknown slug with no url override is a 404", async () => {
    const hub = fakeHub();
    const routes = createMcpOAuthRoutes({
      hubUrl: "http://hub.test",
      requireGrant: allowAll,
      log: () => {},
      credentialCipher: createNoopCredentialCipher(),
      apiCall: hub.apiCall,
    });
    const app = mountAs(routes);
    const response = await app.request("/not-a-preset/start");
    expect(response.status).toBe(404);
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
