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
import { ensureCredential, ensureProvider } from "@corbits/seeding";
import {
  cookiesFromHeader,
  createHubAPI,
  type ApiCall,
} from "@corbits/hub-api-client";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpOAuthProvider, type McpOAuthSession } from "./mcp-oauth";
import { createConnectStateStore, randomToken } from "./pkce";
import { fireConnectedHook, type ServiceConnectedHook } from "./connected-hook";
import { mcpPresetBySlug, type McpPreset } from "./mcp-presets";
import { probeMcpServer, type McpProbeResult } from "./mcp-probe";
import { reportError } from "@corbits/error-sink";
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

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// One provider label for the whole MCP connect surface — the sealed
// state already carries the target slug/url, and the shared store's AAD
// separates this flow's states from the fixed-registry connectors'.
const MCP_OAUTH_STATE_PROVIDER = "mcp-oauth";

const McpOAuthStatePayload = type({
  slug: "string > 0",
  name: "string > 0",
  url: "string > 0",
  returnPath: "string > 0",
  // The `state` value `/start` sent to the authorization server, which
  // the callback requires echoed back — the CSRF binding, distinct from
  // the sealed envelope's own single-use replay nonce (the shared
  // store's concern).
  oauthState: "string > 0",
  "codeVerifier?": "string",
  "clientInformation?": "unknown",
});
type McpOAuthStatePayload = typeof McpOAuthStatePayload.infer;

function parseMcpOAuthStatePayload(
  value: unknown,
): McpOAuthStatePayload | undefined {
  const parsed = McpOAuthStatePayload(value);
  return parsed instanceof type.errors ? undefined : parsed;
}

function cookieName(slug: string): string {
  return `workbench_mcp_oauth_${slug}`;
}

const CLIENT_REJECTED_OAUTH_CODES = new Set([
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_client",
  "unauthorized_client",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/** Classify `/start` `auth()` throws: DCR/client rejection vs unreachable
 * discovery. Prefer the RFC 7591 `error` captured from the HTTP body —
 * SDK 1.30.0 maps unknown codes such as `invalid_redirect_uri` to
 * `ServerError` (`errorCode` `server_error`) and drops the original.
 * Then `errorCode`/`error` on the thrown object. Fall back to
 * registration wording in the message so "redirect URI is not
 * allowlisted" still counts when the body was not JSON. */
function mcpOAuthStartErrorCode(
  cause: unknown,
  capturedCode: string | undefined,
): "discovery_failed" | "client_rejected" {
  for (const code of [
    capturedCode,
    readString(cause, "errorCode"),
    readString(cause, "error"),
  ]) {
    if (code !== undefined && CLIENT_REJECTED_OAUTH_CODES.has(code)) {
      return "client_rejected";
    }
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  for (const code of CLIENT_REJECTED_OAUTH_CODES) {
    if (lower.includes(code)) {
      return "client_rejected";
    }
  }

  if (
    lower.includes("client metadata") ||
    lower.includes("redirect uri") ||
    lower.includes("redirect_uri") ||
    lower.includes("redirection uri") ||
    lower.includes("redirection_uri") ||
    lower.includes("client registration")
  ) {
    return "client_rejected";
  }
  return "discovery_failed";
}

/** Clone 4xx/5xx JSON before the SDK's `parseErrorResponse` consumes the
 * body and maps unknown RFC 7591 codes onto `ServerError`. */
async function fetchCapturingOAuthError(
  captured: { code: string | undefined },
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status < 400) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return response;
  try {
    const body: unknown = await response.clone().json();
    const code = readString(body, "error");
    if (code !== undefined) {
      captured.code = code;
    }
  } catch {
    // report-error-ignore: CL-7247 — malformed JSON on an error response;
    // mcpOAuthStartErrorCode's own message-sniffing fallback classifies
    // the thrown error regardless, so this degrades to that path rather
    // than losing information worth reporting on its own.
  }
  return response;
}

export type CreateMcpOAuthRoutesDeps = {
  hubUrl: string;
  requireGrant: RequireGrant;
  log: (line: string) => void;
  credentialCipher: CredentialCipher;
  /** The curated MCP preset list this build ships — this package
   * carries none of its own (CL-7384), so a caller always supplies
   * one. */
  presets: readonly McpPreset[];
  apiCall?: ApiCall;
  probe?: typeof probeMcpServer;
  defaultReturnPath?: string;
  returnPathAllowlist?: readonly string[];
  /** Fires once for every durably stored connection, whatever the
   * connector — the composition's connect-settling seam (flip in-room
   * connect cards, resume waiting agents). Failures are logged and
   * never surface into the redirect. */
  onConnected?: ServiceConnectedHook;
};

function resolveTarget(
  presets: readonly McpPreset[],
  slugParam: string,
  queryUrl: string | undefined,
  queryName: string | undefined,
): { slug: string; name: string; url: string } | undefined {
  if (queryUrl !== undefined && queryUrl.length > 0) {
    const name =
      queryName !== undefined && queryName.length > 0 ? queryName : slugParam;
    return { slug: slugParam, name, url: queryUrl };
  }
  const preset = mcpPresetBySlug(presets, slugParam);
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
  const stateStore = createConnectStateStore({
    cipher: deps.credentialCipher,
    provider: MCP_OAUTH_STATE_PROVIDER,
    parsePayload: parseMcpOAuthStatePayload,
    ttlMs: OAUTH_STATE_TTL_MS,
  });

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
        deps.presets,
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
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: slugParam,
            outcome: "error",
            code: "not_found",
          }),
          302,
        );
      }
      const queryUrl = c.req.query("url");
      const preset =
        queryUrl === undefined || queryUrl.length === 0
          ? mcpPresetBySlug(deps.presets, slugParam)
          : undefined;
      if (preset !== undefined && preset.connectionMode !== "oauth") {
        // A keyless or token preset has no OAuth dance to start — refuse
        // here rather than failing mid-dance at the provider (GitHub's
        // MCP server, for one, offers no dynamic client registration).
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: preset.slug,
            outcome: "error",
            code: "bad_request",
          }),
          302,
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
      const nonce = randomToken();
      const session: McpOAuthSession = { state: nonce };
      const provider = createMcpOAuthProvider({
        callbackUrl,
        clientName: "Corbits Workbench",
        session,
        ...(preset?.oauthScopes === undefined
          ? {}
          : { scope: preset.oauthScopes.join(" ") }),
      });

      let result: Awaited<ReturnType<typeof auth>>;
      const capturedOAuthError: { code: string | undefined } = {
        code: undefined,
      };
      try {
        result = await auth(provider, {
          serverUrl: target.url,
          fetchFn: (url, init) =>
            fetchCapturingOAuthError(capturedOAuthError, url, init),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(`mcp oauth start failed for "${target.slug}": ${message}`);
        reportError(cause, {
          operation: "mcp_oauth_start",
          tenantId: c.get("tenant").id,
          extra: { slug: target.slug },
        });
        return c.redirect(
          redirectPath(returnPath, {
            mcpOauth: target.slug,
            outcome: "error",
            code: mcpOAuthStartErrorCode(cause, capturedOAuthError.code),
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
        slug: target.slug,
        name: target.name,
        url: target.url,
        returnPath,
        oauthState: nonce,
        ...(session.codeVerifier !== undefined
          ? { codeVerifier: session.codeVerifier }
          : {}),
        ...(session.clientInformation !== undefined
          ? { clientInformation: session.clientInformation }
          : {}),
      };
      const sealed = await stateStore.issue({
        userId: principal.id,
        payload,
      });
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

      // One-shot: the shared store burns the sealed state on this
      // attempt (decrypt + AAD + TTL + user binding + replay guard all
      // inside `consume`), so a replayed callback dies here without a
      // second token exchange.
      const principal = c.get("principal");
      const payload = await stateStore.consume({
        state: sealed,
        userId: principal.id,
      });
      if (payload === undefined) {
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
      const code = c.req.query("code");
      if (code === undefined || code === "") {
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
      if (c.req.query("state") !== payload.oauthState) {
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
      const callbackPreset = mcpPresetBySlug(deps.presets, payload.slug);
      const provider = createMcpOAuthProvider({
        callbackUrl,
        clientName: "Corbits Workbench",
        session,
        ...(callbackPreset?.oauthScopes === undefined
          ? {}
          : { scope: callbackPreset.oauthScopes.join(" ") }),
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
        // Never widen extra beyond identifiers safe to print — the
        // authorization `code` and any codeVerifier are in scope above.
        reportError(cause, {
          operation: "mcp_oauth_token_exchange",
          tenantId: c.get("tenant").id,
          extra: { slug: payload.slug },
        });
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
        await fireConnectedHook(deps.onConnected, deps.log, {
          tenantId: tenant.id,
          principalId: principal.id,
          connectorId: slug,
          displayName: payload.name,
        });
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
        // Never widen extra beyond identifiers safe to print — the
        // exchanged access/refresh tokens are in scope above.
        reportError(cause, {
          operation: "persist_mcp_oauth_connection",
          tenantId: tenant.id,
          extra: { slug: payload.slug },
        });
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
