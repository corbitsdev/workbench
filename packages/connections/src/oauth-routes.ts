// The oauth-pkce/oauth-code half of the Connections surface, generalized
// from `packages/onboarding`'s hand-written OpenRouter and Hugging Face
// routes (see that package's `routes.ts`, pre-CL-6028-wave-2, for the
// two flows this factory now drives instead). One `GET /:connectorId/start`
// and one `GET /:connectorId/callback`, reading everything provider-
// specific off `ConnectorDescriptor.oauth` (`./descriptor.ts`) rather
// than one hand-rolled route pair per provider.
//
// What moved here, unchanged: the state-sealing/PKCE mechanics
// (`./pkce.ts`, untouched by this ticket — see its own header for the
// restart-proof design), the per-user rate limiter, the HttpOnly cookie
// dance, and the duplicate-callback recovery shape (a browser that fires
// the same callback twice must not see the second arrival as a fresh
// failure). What stays deliberately outside this package: what
// "connected" means for the caller's own tenant model. Proving the
// exchanged material and persisting it as a credential
// (`deps.connectCredential`), recovering a duplicate callback
// (`deps.recentlyConnected`), and anything that runs after a credential
// is durably stored — like onboarding's pending-seed / deploy-default-
// workflows step (`deps.afterConnected`) — are all injected. This keeps
// `packages/connections` ignorant of tenant provisioning and workflow
// deployment; `packages/onboarding` supplies its own
// `testAndPersistCredential`/`sealPendingSeed` unchanged as those deps
// when it mounts this factory, exactly preserving the sealed-state and
// pending-seed machinery the survey found already hardened.
//
// `returnPath` (so both `/onboarding` and `/settings/connections` can
// use the same routes): read from `?return=` on `/start`, carried across
// the redirect in a second, non-secret cookie alongside the sealed
// state — not folded into the sealed state payload itself, so
// `./pkce.ts`'s AEAD-sealed shape stays exactly what the recent
// restart-proofing hardened.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type } from "arktype";
import type { AppEnv } from "@intx/hub-api";
import type { CredentialCipher } from "@intx/types";
import { cookiesFromHeader } from "@workbench/hub-client";
import {
  createConnectStateStore,
  generatePKCEPair,
  type ConnectStateStore,
} from "./pkce";
import {
  fireConnectedHook,
  type ServiceConnectedHook,
} from "./connected-hook";
import type { ConnectorDescriptor } from "./descriptor";
import { CONNECTOR_REGISTRY } from "./registry";

/**
 * The two return surfaces this wave's callers actually mount at
 * (`apps/web`'s onboarding wizard and the settings Connections page) —
 * a deliberately closed default. A caller that needs a third surface
 * passes its own `returnPathAllowlist`, naming it explicitly, rather
 * than this factory silently accepting any path-shaped string. See
 * `sanitizeReturnPath`'s own header for why an allowlist and not just
 * shape validation.
 */
export const DEFAULT_RETURN_PATH_ALLOWLIST: readonly string[] = [
  "/onboarding",
  "/settings/",
];

/**
 * Turns an untrusted `?return=` hint (or the cookie that carries it
 * across the redirect) into a same-origin path this factory will
 * actually redirect to, or `defaultReturnPath` on anything that isn't
 * obviously one. This is a redirect target read straight off the
 * request before authentication runs (the signed_out/not_configured/
 * rate_limited early exits all redirect using it), so it is validated
 * before ANY branch — including the ones that never reach a real
 * connect flow — ever builds a `Location` header from it.
 *
 * Shape checks alone (single leading slash, no backslash, no embedded
 * scheme) stop the classic open-redirect payloads
 * (`https://evil.com`, `//evil.com`, `/\evil.com`, `%2F%2Fevil.com`
 * after decoding) but still leave the door open to any same-origin
 * path an attacker picks — which is enough for a phishing-adjacent
 * redirect even without leaving the origin. The prefix allowlist below
 * closes that: only the return surfaces this factory's callers
 * actually mount at are ever honored, everything else falls back to
 * `defaultReturnPath` exactly as an absent `?return=` would.
 *
 * Failure is always silent — a malformed or malicious hint never
 * surfaces as an error page, only as a fallback to the default path,
 * matching how an absent `?return=` already behaves.
 */
export function sanitizeReturnPath(
  raw: string | undefined,
  defaultReturnPath: string,
  allowlist: readonly string[],
): string {
  if (raw === undefined || raw === "") return defaultReturnPath;

  // Defense in depth against double-encoding: the query string and the
  // cookie value are each already decoded once by the layer that read
  // them (Hono's query parser, Hono's cookie parser), so a value that
  // still contains percent-encoding here was encoded twice by whoever
  // sent it. Decoding once more, if it changes anything, re-runs every
  // check below against what the value actually resolves to rather than
  // trusting a still-encoded payload to look safe.
  let candidate = raw;
  try {
    const decodedOnceMore = decodeURIComponent(candidate);
    if (decodedOnceMore !== candidate) candidate = decodedOnceMore;
  } catch {
    return defaultReturnPath;
  }

  // CR/LF first, regardless of what the rest of the value looks like —
  // a header/response-splitting payload can otherwise ride along inside
  // an otherwise-allowlisted-looking prefix (e.g. "/onboarding\r\n...").
  if (/[\r\n]/.test(candidate)) return defaultReturnPath;

  // The browser's own backslash-as-forward-slash normalization means
  // "/\evil.com" reaches evil.com exactly like "//evil.com" would.
  if (candidate.includes("\\")) return defaultReturnPath;

  // Exactly one leading slash: rejects both a bare host/scheme-relative
  // value ("evil.com", "https://evil.com" — caught by the missing
  // leading slash) and a protocol-relative one ("//evil.com").
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return defaultReturnPath;
  }

  // Belt and suspenders against any embedded absolute URL a parser
  // downstream might resolve against ("/x?next=https://evil.com" is
  // fine as a *query value* elsewhere, but never as this redirect
  // target itself).
  if (candidate.includes("://")) return defaultReturnPath;

  const allowed = allowlist.some(
    (prefix) => candidate === prefix || candidate.startsWith(prefix),
  );
  return allowed ? candidate : defaultReturnPath;
}

export type OAuthStoreOutcome =
  | {
      readonly kind: "connected";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly principalId: string;
      readonly tenantDomain: string;
    }
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" };

export type CreateOAuthConnectRoutesDeps<E extends AppEnv = AppEnv> = {
  readonly hubUrl: string;
  readonly log: (line: string) => void;
  /** Seals the PKCE+state cookie parked between `/start` and
   * `/callback`. The same `CredentialCipher` every other secret-at-rest
   * seam in the hub shares. */
  readonly credentialCipher: CredentialCipher;
  /** Test-only override, defaulting to `CONNECTOR_REGISTRY`. */
  readonly registry?: Readonly<Record<string, ConnectorDescriptor>>;
  /** The env bag a descriptor's `oauth.clientId(env)` reads a
   * registered app id from (e.g. `{huggingfaceClientId}`). */
  readonly oauthEnv?: Readonly<Record<string, string | undefined>>;
  /** Proves the exchanged material and persists it as a credential on
   * the caller's own tenant — the fast half only, matching
   * `packages/onboarding`'s `testAndPersistCredential` exactly.
   * Required: without a caller-supplied store step, a successful
   * exchange would have nowhere to land. */
  readonly connectCredential: (args: {
    /** Typed by the factory's own env parameter, so a tenant-scoped
     * caller (`E = TenantEnv`, mounted inside the platform's tenant
     * middleware) reads `c.get("tenant")`/`c.get("principal")` directly
     * with no cast — see `createTenantConnectCredential` in
     * `./oauth-tenant-connect.ts`. A caller with no tenant middleware
     * (`packages/onboarding`'s own mount, `E = AppEnv`) is free to
     * ignore it. */
    c: Context<E>;
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    apiKey: string;
    credentialMetadata?: Record<string, unknown>;
    refreshToken?: string;
  }) => Promise<OAuthStoreOutcome>;
  /** Best-effort duplicate-callback recovery — see this module's header.
   * Absent means a double-fired callback is always reported as
   * `state_expired`, never silently treated as success. */
  readonly recentlyConnected?: (args: {
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    withinMs: number;
  }) => Promise<{ tenantSlug: string } | undefined>;
  /** Runs once a credential is durably stored, only for a connector
   * whose `oauth.deploysDefaultWorkflows` is true — onboarding's
   * pending-seed sealing lives here, entirely outside this package.
   * Given the Hono `Context` directly so it can set its own cookie. */
  readonly afterConnected?: (args: {
    c: Context<E>;
    connectorId: string;
    userId: string;
    apiKey: string;
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  }) => Promise<void>;
  /** Fires once for every durably stored connection, whatever the
   * connector — the composition's connect-settling seam (flip in-room
   * connect cards, resume waiting agents). Failures are logged and
   * never surface into the redirect. */
  readonly onConnected?: ServiceConnectedHook;
  /** Where a caller lands when no `?return=` was given on `/start`, or
   * when the given one fails `sanitizeReturnPath`. */
  readonly defaultReturnPath?: string;
  /** Prefixes a `?return=` hint must match to be honored at all —
   * defaults to `DEFAULT_RETURN_PATH_ALLOWLIST`. See
   * `sanitizeReturnPath`'s header for why shape validation alone isn't
   * enough. */
  readonly returnPathAllowlist?: readonly string[];
};

const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
const CONNECT_START_RATE_LIMIT_MS = 10_000;

const VerifierStatePayload = type({
  // Empty for a non-PKCE flow (GitHub's confidential-client web flow
  // seals `codeVerifier: ""`), so this must accept the empty string —
  // `string > 0` here silently expired every non-PKCE callback
  // (CL-6394).
  codeVerifier: "string",
});
type VerifierStatePayload = typeof VerifierStatePayload.infer;

function parseVerifierStatePayload(
  value: unknown,
): VerifierStatePayload | undefined {
  const parsed = VerifierStatePayload(value);
  return parsed instanceof type.errors ? undefined : parsed;
}

export function createOAuthConnectRoutes<E extends AppEnv = AppEnv>(
  deps: CreateOAuthConnectRoutesDeps<E>,
): Hono<E> {
  const app = new Hono<E>();
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const oauthEnv = deps.oauthEnv ?? {};
  const defaultReturnPath = deps.defaultReturnPath ?? "/onboarding";
  const returnPathAllowlist =
    deps.returnPathAllowlist ?? DEFAULT_RETURN_PATH_ALLOWLIST;
  const secureCookies = deps.hubUrl.startsWith("https:");

  const stateStores = new Map<
    string,
    ConnectStateStore<VerifierStatePayload>
  >();
  function stateStoreFor(connectorId: string) {
    let store = stateStores.get(connectorId);
    if (store === undefined) {
      store = createConnectStateStore({
        cipher: deps.credentialCipher,
        provider: connectorId,
        parsePayload: parseVerifierStatePayload,
        ttlMs: CONNECT_STATE_TTL_MS,
      });
      stateStores.set(connectorId, store);
    }
    return store;
  }

  const lastStartByKey = new Map<string, number>();

  function findOAuthDescriptor(connectorId: string) {
    const descriptor = registry[connectorId];
    if (descriptor === undefined || descriptor.oauth === undefined) {
      return undefined;
    }
    return descriptor as ConnectorDescriptor & {
      oauth: NonNullable<ConnectorDescriptor["oauth"]>;
    };
  }

  function stateCookieName(connectorId: string): string {
    return `workbench_${connectorId}_connect`;
  }
  function returnCookieName(connectorId: string): string {
    return `workbench_${connectorId}_connect_return`;
  }

  function redirectPath(
    returnPath: string,
    connectorId: string,
    params: Record<string, string>,
  ): string {
    const query = new URLSearchParams(params);
    query.set("connect", connectorId);
    return `${returnPath}?${query.toString()}`;
  }

  app.get("/:connectorId/start", async (c) => {
    const connectorId = c.req.param("connectorId");
    const descriptor = findOAuthDescriptor(connectorId);
    if (descriptor === undefined) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `Unknown connector: ${connectorId}`,
          },
        },
        404,
      );
    }

    const returnPath = sanitizeReturnPath(
      c.req.query("return"),
      defaultReturnPath,
      returnPathAllowlist,
    );
    const user = c.get("user");
    if (!user) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "signed_out",
        }),
        302,
      );
    }

    const clientId = descriptor.oauth.clientId?.(oauthEnv);
    if (descriptor.oauth.clientId !== undefined && clientId === undefined) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }
    if (
      descriptor.oauth.clientSecret !== undefined &&
      descriptor.oauth.clientSecret(oauthEnv) === undefined
    ) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }

    const rateLimitKey = `${connectorId}:${user.id}`;
    const now = Date.now();
    const lastStart = lastStartByKey.get(rateLimitKey);
    if (
      lastStart !== undefined &&
      now - lastStart < CONNECT_START_RATE_LIMIT_MS
    ) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "rate_limited",
        }),
        302,
      );
    }
    lastStartByKey.set(rateLimitKey, now);

    const pkce = descriptor.oauth.usesPKCE
      ? await generatePKCEPair()
      : undefined;
    const state = await stateStoreFor(connectorId).issue({
      userId: user.id,
      payload: { codeVerifier: pkce?.codeVerifier ?? "" },
    });
    setCookie(c, stateCookieName(connectorId), state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies,
      path: "/",
      maxAge: 600,
    });
    setCookie(c, returnCookieName(connectorId), returnPath, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies,
      path: "/",
      maxAge: 600,
    });

    // Origin from configuration (the hub's public BASE_URL — the origin
    // the provider must send the browser back to, whatever host header
    // this request arrived under), path from the request so the mount
    // prefix is never guessed at.
    const callbackUrl = new URL(
      c.req.path.replace(/\/start$/, "/callback"),
      deps.hubUrl,
    ).toString();
    const authorizeUrlArgs: Parameters<
      typeof descriptor.oauth.buildAuthorizeUrl
    >[0] = {
      callbackUrl,
      state,
      ...(pkce !== undefined ? { codeChallenge: pkce.codeChallenge } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    };
    const authUrl = descriptor.oauth.buildAuthorizeUrl(authorizeUrlArgs);
    return c.redirect(authUrl.toString(), 302);
  });

  app.get("/:connectorId/callback", async (c) => {
    const connectorId = c.req.param("connectorId");
    const descriptor = findOAuthDescriptor(connectorId);
    if (descriptor === undefined) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `Unknown connector: ${connectorId}`,
          },
        },
        404,
      );
    }

    // The cookie is never trusted any more than the query param was at
    // /start -- it is still attacker-influenced input (this same
    // handler wrote it, but only after /start's own sanitization; this
    // second pass is defense in depth, not redundant, against anything
    // that could tamper with or replay a cookie carrying a value /start
    // never actually produced).
    const returnPath = sanitizeReturnPath(
      getCookie(c, returnCookieName(connectorId)),
      defaultReturnPath,
      returnPathAllowlist,
    );
    deleteCookie(c, returnCookieName(connectorId), { path: "/" });

    const user = c.get("user");
    if (!user) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "signed_out",
        }),
        302,
      );
    }

    const clientId = descriptor.oauth.clientId?.(oauthEnv);
    if (descriptor.oauth.clientId !== undefined && clientId === undefined) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }
    const clientSecret = descriptor.oauth.clientSecret?.(oauthEnv);
    if (
      descriptor.oauth.clientSecret !== undefined &&
      clientSecret === undefined
    ) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }

    const cookieState = getCookie(c, stateCookieName(connectorId));
    deleteCookie(c, stateCookieName(connectorId), { path: "/" });
    const code = c.req.query("code");
    const queryState = c.req.query("state");
    const cookies = cookiesFromHeader(c.req.header("cookie"));

    // Belt and suspenders for a provider that echoes `state` in its
    // callback query (Hugging Face): a callback whose query state
    // disagrees with the cookie it arrived with is rejected before the
    // state store is even consulted, on top of the store's own
    // single-use/cross-user checks.
    if (
      cookieState === undefined ||
      code === undefined ||
      code === "" ||
      (descriptor.oauth.echoesState && queryState !== cookieState)
    ) {
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "state_expired",
        }),
        302,
      );
    }

    const statePayload = await stateStoreFor(connectorId).consume({
      state: cookieState,
      userId: user.id,
    });
    if (statePayload === undefined) {
      // Not necessarily a real failure: a browser that fires this exact
      // callback twice burns the state on its first, successful arrival
      // and only ever sees this branch on the second.
      const recovered = await deps.recentlyConnected?.({
        connectorId,
        userId: user.id,
        userEmail: user.email,
        cookies,
        withinMs: CONNECT_STATE_TTL_MS,
      });
      if (recovered) {
        return c.redirect(
          redirectPath(returnPath, connectorId, {
            outcome: "connected",
            tenantSlug: recovered.tenantSlug,
          }),
          302,
        );
      }
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "state_expired",
        }),
        302,
      );
    }

    const callbackUrl = new URL(c.req.path, deps.hubUrl).toString();
    const exchangeArgs: Parameters<typeof descriptor.oauth.exchange>[0] = {
      code,
      redirectUri: callbackUrl,
      ...(descriptor.oauth.usesPKCE
        ? { codeVerifier: statePayload.codeVerifier }
        : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
    };
    const exchanged = await descriptor.oauth.exchange(exchangeArgs);
    if (!exchanged.ok) {
      deps.log(
        `${connectorId} connect for user ${user.id}: code exchange failed: ${exchanged.message}`,
      );
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "exchange_failed",
        }),
        302,
      );
    }

    try {
      const connectCredentialArgs: Parameters<
        typeof deps.connectCredential
      >[0] = {
        c,
        connectorId,
        userId: user.id,
        userEmail: user.email,
        cookies,
        apiKey: exchanged.apiKey,
      };
      if (exchanged.expiresAt !== undefined)
        connectCredentialArgs.credentialMetadata = {
          expiresAt: exchanged.expiresAt,
        };
      if (exchanged.refreshToken !== undefined)
        connectCredentialArgs.refreshToken = exchanged.refreshToken;
      const result = await deps.connectCredential(connectCredentialArgs);
      if (result.kind === "invalid-credential") {
        deps.log(
          `${connectorId} connect for user ${user.id}: exchanged material failed its probe: ${result.message}`,
        );
        return c.redirect(
          redirectPath(returnPath, connectorId, {
            outcome: "error",
            code: "key_rejected",
          }),
          302,
        );
      }
      if (result.kind === "no-personal-bench") {
        return c.redirect(
          redirectPath(returnPath, connectorId, {
            outcome: "error",
            code: "no_bench",
          }),
          302,
        );
      }

      if (descriptor.oauth.deploysDefaultWorkflows) {
        await deps.afterConnected?.({
          c,
          connectorId,
          userId: user.id,
          apiKey: exchanged.apiKey,
          tenantId: result.tenantId,
          tenantSlug: result.tenantSlug,
          principalId: result.principalId,
          tenantDomain: result.tenantDomain,
        });
      }

      await fireConnectedHook(deps.onConnected, deps.log, {
        tenantId: result.tenantId,
        principalId: result.principalId,
        connectorId,
        displayName: descriptor.displayName,
      });

      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "connected",
          tenantSlug: result.tenantSlug,
        }),
        302,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `${connectorId} connect setup failed for user ${user.id}: ${message}`,
      );
      return c.redirect(
        redirectPath(returnPath, connectorId, {
          outcome: "error",
          code: "setup_failed",
        }),
        302,
      );
    }
  });

  return app;
}
