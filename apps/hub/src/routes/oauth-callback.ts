import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  findOAuthProviderConfig,
  inboxCapabilityPreferenceKey,
} from "@workbench/shared";
import { requireOAuthStateSecret } from "../config";
import type { HubDb } from "../db";
import {
  isCapabilityAllowedForPrincipal,
  setPrincipalCapabilityGrant,
} from "../lib/capability-grants";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  completeConnect,
  resolveOAuthClientForProvider,
} from "../lib/oauth-flow";
import { verifyState } from "../lib/oauth-crypto";
import type { FetchLike, PendingAuthorizationStore } from "../lib/oauth-flow";
import { oauthCallbackRedirectUri } from "../lib/oauth-redirect";

const log = getLogger(["routes", "oauth-callback"]);

export interface CreateOAuthCallbackDeps {
  db: HubDb;
  /** Native grant store — the per-(principal,provider) capability gate is
   * re-checked here (fail-closed) before a token is written. */
  grantStore: GrantStore;
  pendingStore: PendingAuthorizationStore;
  /** Where the browser is sent after the flow completes (the web app's
   * Connections page). Success appends `?connected=<provider>`, failure
   * `?connect_error=<provider>`. */
  redirectBase: string;
  /** Public base URL of the hub, used to derive the OAuth redirect URI (must
   * match the one sent at authorize time and registered with the provider). */
  redirectUriBase: string;
  /** Injected at the boundary so tests can drive the token exchange
   * deterministically; defaults to the global fetch in production. */
  fetchImpl?: FetchLike;
}

// Public OAuth callback (CL-3356 pillar A). Mounted OUTSIDE the session-auth
// wall — a provider redirect is a top-level browser navigation that may not
// carry the session cookie. Trust is established by the HMAC-signed `state`
// (bound to the member principal at authorize time), not by a session.
export function createOAuthCallbackRouter(deps: CreateOAuthCallbackDeps): Hono {
  const { db, grantStore, pendingStore, redirectBase, redirectUriBase } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const app = new Hono();

  // `provider` is validated against the catalog before reaching here, so it is
  // a known-safe literal — never the raw route param.
  function redirect(provider: string, ok: boolean): string {
    const url = new URL(redirectBase);
    url.searchParams.set(ok ? "connected" : "connect_error", provider);
    return url.toString();
  }

  // Generic failure landing that does NOT echo an unvalidated route param.
  function genericError(): string {
    const url = new URL(redirectBase);
    url.searchParams.set("connect_error", "unknown");
    return url.toString();
  }

  app.get(
    "/oauth/callback/:provider",
    describeRoute({
      tags: ["OAuth"],
      summary: "OAuth provider redirect callback (code-for-token exchange)",
      responses: {
        302: { description: "Redirect back to the Connections page" },
      },
    }),
    async (c) => {
      // Validate the provider against the catalog BEFORE reflecting it anywhere
      // — an unknown param lands on a generic error, never echoed back.
      const cfg = findOAuthProviderConfig(c.req.param("provider"));
      if (!cfg) return c.redirect(genericError());
      const providerName = cfg.providerName;

      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) return c.redirect(redirect(providerName, false));

      try {
        const stateSecret = requireOAuthStateSecret();
        // The tenant + member are carried in the HMAC-signed state; verify it
        // here so the owner-client lookup + capability re-check use the
        // authoritative principal. completeConnect re-verifies the state,
        // enforces freshness, and consumes the single-use PKCE verifier.
        const peeked = verifyState(state, stateSecret);
        if (!peeked) {
          return c.redirect(redirect(providerName, false));
        }

        // Fail-closed re-check: the capability may have been revoked between
        // authorize and callback. Never write a token the caller is no longer
        // granted.
        const allowed = await isCapabilityAllowedForPrincipal(
          grantStore,
          peeked.tenantId,
          peeked.memberPrincipalId,
          providerName,
        );
        if (!allowed) {
          return c.redirect(redirect(providerName, false));
        }

        const clientConfig = await resolveOAuthClientForProvider(
          db,
          peeked.tenantId,
          cfg,
          oauthCallbackRedirectUri(redirectUriBase, providerName),
        );
        if (!clientConfig) {
          throw new Error(`${cfg.label} OAuth client is not configured`);
        }
        const result = await completeConnect({
          db,
          providerConfig: cfg,
          clientConfig,
          code,
          state,
          stateSecret,
          pendingStore,
          fetchImpl,
        });
        // Self-service enablement (CL-3510): a completed connection with the
        // member's `inbox.capability.<provider>` opt-in on (default on) writes
        // the per-principal capability grant so the connection immediately has
        // effect. The opt-in being off leaves the credential stored but the
        // capability un-granted — the member connected but has not turned it on.
        const prefs = await readMemberPreferences(
          db,
          result.tenantId,
          result.memberPrincipalId,
        );
        const optedIn =
          prefs[inboxCapabilityPreferenceKey(providerName)] !== false;
        await setPrincipalCapabilityGrant(db, {
          tenantId: result.tenantId,
          principalId: result.memberPrincipalId,
          provider: providerName,
          enabled: optedIn,
        });
        log.info("oauth connect completed", {
          provider: providerName,
          memberPrincipalId: result.memberPrincipalId,
        });
        return c.redirect(redirect(providerName, true));
      } catch (err) {
        log.error("oauth connect failed", {
          provider: providerName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.redirect(redirect(providerName, false));
      }
    },
  );

  return app;
}
