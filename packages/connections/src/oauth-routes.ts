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
import type { AppEnv } from "@intx/hub-api";
import type { CredentialCipher } from "@intx/types";
import { createConnectStateStore, generatePKCEPair } from "./pkce";
import type { ConnectorDescriptor } from "./descriptor";
import { CONNECTOR_REGISTRY } from "./registry";

function cookiesFromHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
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

export type CreateOAuthConnectRoutesDeps = {
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
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    apiKey: string;
    credentialMetadata?: Record<string, unknown>;
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
    c: Context;
    connectorId: string;
    userId: string;
    apiKey: string;
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  }) => Promise<void>;
  /** Where a caller lands when no `?return=` was given on `/start`. */
  readonly defaultReturnPath?: string;
};

const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
const CONNECT_START_RATE_LIMIT_MS = 10_000;

export function createOAuthConnectRoutes(
  deps: CreateOAuthConnectRoutesDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const oauthEnv = deps.oauthEnv ?? {};
  const defaultReturnPath = deps.defaultReturnPath ?? "/onboarding";
  const secureCookies = deps.hubUrl.startsWith("https:");

  const stateStores = new Map<
    string,
    ReturnType<typeof createConnectStateStore>
  >();
  function stateStoreFor(connectorId: string) {
    let store = stateStores.get(connectorId);
    if (store === undefined) {
      store = createConnectStateStore({
        cipher: deps.credentialCipher,
        provider: connectorId,
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

    const returnPath = c.req.query("return") ?? defaultReturnPath;
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
      codeVerifier: pkce?.codeVerifier ?? "",
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
    const authUrl = descriptor.oauth.buildAuthorizeUrl({
      callbackUrl,
      state,
      ...(pkce !== undefined ? { codeChallenge: pkce.codeChallenge } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    });
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

    const returnPath =
      getCookie(c, returnCookieName(connectorId)) ?? defaultReturnPath;
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

    const codeVerifier = await stateStoreFor(connectorId).consume({
      state: cookieState,
      userId: user.id,
    });
    if (codeVerifier === undefined) {
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
    const exchanged = await descriptor.oauth.exchange({
      code,
      ...(descriptor.oauth.usesPKCE ? { codeVerifier } : {}),
      redirectUri: callbackUrl,
      ...(clientId !== undefined ? { clientId } : {}),
    });
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
      const result = await deps.connectCredential({
        connectorId,
        userId: user.id,
        userEmail: user.email,
        cookies,
        apiKey: exchanged.apiKey,
        ...(exchanged.expiresAt !== undefined
          ? { credentialMetadata: { expiresAt: exchanged.expiresAt } }
          : {}),
      });
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
