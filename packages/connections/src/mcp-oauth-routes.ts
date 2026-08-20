// The MCP-server connector's OAuth connect flow (CL-6152): the same
// `GET /:id/start` + `GET /:id/callback` shape `./oauth-routes.ts` runs
// for the fixed-registry OAuth connectors (OpenRouter, Hugging Face), but
// driven by the official `@modelcontextprotocol/sdk` client's own
// `auth()` orchestrator (`./mcp-oauth.ts`) instead of a per-provider
// hand-written `buildAuthorizeUrl`/`exchange` pair -- an MCP server's
// authorization server is discovered per the MCP spec (RFC 9728/8414 +
// dynamic client registration), never a value this package hardcodes.
//
// Mounted tenant-scoped, alongside `createMcpServerRoutes`, at
// `/api/tenants/:tenantId/mcp-servers/oauth` -- `/:slug/start` resolves a
// curated preset (`./mcp-presets.ts`) by slug, or an ad hoc `?url=&name=`
// pair supplied by an authorized client. A successful callback stores the exchanged access
// token through the exact same `ensureProvider`/`ensureCredential` seam
// `./mcp-server-routes.ts`'s manual connect uses, under the same
// `mcp:<slug>` naming, so an OAuth-connected server is indistinguishable
// at read time from one connected with a pasted token.
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { CredentialCipher } from "@intx/types";
import { MCP_STREAMABLE_HTTP_PROVIDER_KEY } from "@corbits/credential-providers";
import {
  cookiesFromHeader,
  ensureCredential,
  ensureProvider,
  type ApiCall,
} from "@workbench/hub-client";
import { createHubAPI } from "@workbench/hub-client";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpOAuthProvider, type McpOAuthSession } from "./mcp-oauth";
import { mcpPresetBySlug } from "./mcp-presets";
import { probeMcpServer, type McpProbeResult } from "./mcp-probe";
import {
  listMcpProviders,
  providerName,
  slugOf,
  slugify,
  uniqueSlug,
} from "./mcp-server-routes";
import {
  DEFAULT_RETURN_PATH_ALLOWLIST,
  sanitizeReturnPath,
} from "./oauth-routes";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const McpOAuthStatePayload = type({
  principalId: "string > 0",
  slug: "string > 0",
  name: "string > 0",
  url: "string > 0",
  returnPath: "string > 0",
  nonce: "string > 0",
  expiresAt: "number",
  "codeVerifier?": "string",
  "clientInformation?": "unknown",
});
type McpOAuthStatePayload = typeof McpOAuthStatePayload.infer;

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stateAad(): string {
  return JSON.stringify(["mcp-oauth-connect-state"]);
}

function cookieName(slug: string): string {
  return `workbench_mcp_oauth_${slug}`;
}

export type CreateMcpOAuthRoutesDeps = {
  hubUrl: string;
  requireGrant: RequireGrant;
  log: (line: string) => void;
  credentialCipher: CredentialCipher;
  apiCall?: ApiCall;
  probe?: typeof probeMcpServer;
  defaultReturnPath?: string;
  returnPathAllowlist?: readonly string[];
};

function resolveTarget(
  slugParam: string,
  queryUrl: string | undefined,
  queryName: string | undefined,
): { slug: string; name: string; url: string } | undefined {
  if (queryUrl !== undefined && queryUrl.length > 0) {
    const name =
      queryName !== undefined && queryName.length > 0 ? queryName : slugParam;
    return { slug: slugParam, name, url: queryUrl };
  }
  const preset = mcpPresetBySlug(slugParam);
  if (preset === undefined) return undefined;
  return { slug: preset.slug, name: preset.displayName, url: preset.url };
}

export function createMcpOAuthRoutes(
  deps: CreateMcpOAuthRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const api = deps.apiCall ?? createHubAPI(deps.hubUrl);
  const probe = deps.probe ?? probeMcpServer;
  const defaultReturnPath = deps.defaultReturnPath ?? "/plugins";
  const returnPathAllowlist =
    deps.returnPathAllowlist ?? DEFAULT_RETURN_PATH_ALLOWLIST;
  const secureCookies = deps.hubUrl.startsWith("https:");

  function redirectPath(
    returnPath: string,
    params: Record<string, string>,
  ): string {
    const query = new URLSearchParams(params);
    return `${returnPath}?${query.toString()}`;
  }

  app.get(
    "/:slug/start",
    deps.requireGrant("credential:*", "create"),
    async (c) => {
      const slugParam = c.req.param("slug");
      const target = resolveTarget(
        slugParam,
        c.req.query("url"),
        c.req.query("name"),
      );
      const returnPath = sanitizeReturnPath(
        c.req.query("return"),
        defaultReturnPath,
        returnPathAllowlist,
      );
      if (target === undefined) {
        return c.json(
          ErrorEnvelope(
            "not_found",
            `Unknown MCP server preset: "${slugParam}"`,
          ),
          404,
        );
      }

      const principal = c.get("principal");
      const callbackUrl = new URL(
        c.req.path.replace(/\/start$/, "/callback"),
        deps.hubUrl,
      ).toString();
      // Minted before `auth()` runs, not after: `auth()` reads it via
      // `provider.state()` while building the authorize URL, so it must
      // already be on the session by the time `redirectToAuthorization`
      // fires. The same value is what `/callback` requires the provider's
      // `?state=` to match.
      const nonce = randomNonce();
      const session: McpOAuthSession = { state: nonce };
      const provider = createMcpOAuthProvider({
        callbackUrl,
        clientName: "Corbits Workbench",
        session,
      });

      let result: Awaited<ReturnType<typeof auth>>;
      try {
        result = await auth(provider, { serverUrl: target.url });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(`mcp oauth start failed for "${target.slug}": ${message}`);
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: target.slug,
            outcome: "error",
            code: "discovery_failed",
          }),
          302,
        );
      }
      const authorizationUrl = (
        provider as unknown as { capturedAuthorizationUrl?: URL }
      ).capturedAuthorizationUrl;
      if (result !== "REDIRECT" || authorizationUrl === undefined) {
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: target.slug,
            outcome: "error",
            code: "no_authorization_needed",
          }),
          302,
        );
      }

      const payload: McpOAuthStatePayload = {
        principalId: principal.id,
        slug: target.slug,
        name: target.name,
        url: target.url,
        returnPath,
        nonce,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        ...(session.codeVerifier !== undefined
          ? { codeVerifier: session.codeVerifier }
          : {}),
        ...(session.clientInformation !== undefined
          ? { clientInformation: session.clientInformation }
          : {}),
      };
      const sealed = await deps.credentialCipher.encrypt(
        JSON.stringify(payload),
        stateAad(),
      );
      setCookie(c, cookieName(target.slug), sealed, {
        httpOnly: true,
        sameSite: "Lax",
        secure: secureCookies,
        path: "/",
        maxAge: 600,
      });
      return c.redirect(authorizationUrl.toString(), 302);
    },
  );

  app.get(
    "/:slug/callback",
    deps.requireGrant("credential:*", "create"),
    async (c) => {
      const slugParam = c.req.param("slug");
      const sealed = getCookie(c, cookieName(slugParam));
      deleteCookie(c, cookieName(slugParam), { path: "/" });

      const fallbackReturn = sanitizeReturnPath(
        undefined,
        defaultReturnPath,
        returnPathAllowlist,
      );
      if (sealed === undefined) {
        return c.redirect(
          redirectPath(fallbackReturn, {
            mcpOauth: slugParam,
            outcome: "error",
            code: "state_expired",
          }),
          302,
        );
      }

      let payload: McpOAuthStatePayload;
      try {
        const plaintext = await deps.credentialCipher.decrypt(
          sealed,
          stateAad(),
        );
        const parsed = McpOAuthStatePayload(JSON.parse(plaintext));
        if (parsed instanceof type.errors) throw new Error(parsed.summary);
        payload = parsed;
      } catch {
        return c.redirect(
          redirectPath(fallbackReturn, {
            mcpOauth: slugParam,
            outcome: "error",
            code: "state_expired",
          }),
          302,
        );
      }

      const returnPath = sanitizeReturnPath(
        payload.returnPath,
        defaultReturnPath,
        returnPathAllowlist,
      );
      const principal = c.get("principal");
      const code = c.req.query("code");
      if (
        payload.expiresAt <= Date.now() ||
        payload.principalId !== principal.id ||
        code === undefined ||
        code === ""
      ) {
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "state_expired",
          }),
          302,
        );
      }

      // CSRF check: `/start` always sends `state=<nonce>` on the
      // authorize URL (see `mcp-oauth.ts`'s `state()`), so the provider
      // must echo that exact value back -- never optional-when-absent.
      // A missing or mismatched `state` means this callback did not
      // originate from the authorize redirect this session minted.
      if (c.req.query("state") !== payload.nonce) {
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "state_mismatch",
          }),
          302,
        );
      }

      const callbackUrl = new URL(c.req.path, deps.hubUrl).toString();
      const session: McpOAuthSession = {
        ...(payload.codeVerifier !== undefined
          ? { codeVerifier: payload.codeVerifier }
          : {}),
        ...(payload.clientInformation !== undefined
          ? {
              clientInformation:
                payload.clientInformation as OAuthClientInformationMixed,
            }
          : {}),
      };
      const provider = createMcpOAuthProvider({
        callbackUrl,
        clientName: "Corbits Workbench",
        session,
      });

      let result: Awaited<ReturnType<typeof auth>>;
      try {
        result = await auth(provider, {
          serverUrl: payload.url,
          authorizationCode: code,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `mcp oauth token exchange failed for "${payload.slug}": ${message}`,
        );
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "exchange_failed",
          }),
          302,
        );
      }
      if (result !== "AUTHORIZED" || session.tokens === undefined) {
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "exchange_failed",
          }),
          302,
        );
      }

      const accessToken = session.tokens.access_token;
      const test: McpProbeResult = await probe(payload.url, accessToken);
      if (!test.ok) {
        deps.log(
          `mcp oauth connect for "${payload.slug}" exchanged a token but the post-auth probe failed: ${test.message}`,
        );
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "connect_failed",
          }),
          302,
        );
      }

      const tenant = c.get("tenant");
      const cookies = cookiesFromHeader(c.req.header("cookie"));
      try {
        const existingProviders = await listMcpProviders(
          api,
          cookies,
          tenant.id,
        );
        const takenSlugs = new Set(
          existingProviders.map((p) => slugOf(p.name)),
        );
        const slug = takenSlugs.has(payload.slug)
          ? payload.slug
          : uniqueSlug(slugify(payload.name), takenSlugs);
        // The FULL endpoint URL, matching the API-key connect path — the
        // origin alone drops paths like `/mcp` and every downstream call
        // dies at the CDN ("supports only cachable requests").
        const providerId = await ensureProvider(
          api,
          cookies,
          {
            tenantId: tenant.id,
            name: providerName(slug),
            plugin: MCP_STREAMABLE_HTTP_PROVIDER_KEY,
            apiBaseUrl: payload.url,
          },
          deps.log,
        );
        // Stored as `oauth_token` (CL-6207), not `api_key` — an MCP server
        // that issued a refresh token gets one that actually refreshes at
        // expiry instead of dying; one that didn't (mirroring the
        // documented Hugging Face precedent) stores no refreshSecret/
        // expiresAt at all, never a coerced empty value.
        const { refresh_token: refreshToken, expires_in: expiresIn } =
          session.tokens;
        await ensureCredential(
          api,
          cookies,
          {
            tenantId: tenant.id,
            providerId,
            name: payload.name,
            secret: accessToken,
            type: "oauth_token",
            ...(refreshToken !== undefined
              ? { refreshSecret: refreshToken }
              : {}),
            ...(expiresIn !== undefined
              ? {
                  expiresAt: new Date(
                    Date.now() + expiresIn * 1000,
                  ).toISOString(),
                }
              : {}),
            // `clientInformation` (when DCR minted one) lets a later
            // refresh reuse the same registered client instead of the
            // authorization server seeing a fresh dynamic registration
            // every sweep tick.
            metadata: {
              url: payload.url,
              name: payload.name,
              ...(session.clientInformation !== undefined
                ? { clientInformation: session.clientInformation }
                : {}),
            },
            verified: true,
          },
          deps.log,
        );
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: slug,
            outcome: "connected",
            toolCount: String(test.toolCount),
          }),
          302,
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `mcp oauth connect setup failed for tenant ${tenant.id}, slug ${payload.slug}: ${message}`,
        );
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: payload.slug,
            outcome: "error",
            code: "setup_failed",
          }),
          302,
        );
      }
    },
  );

  return app;
}
