import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { GrantStore } from "@intx/authz";
import {
  ConnectionAuthorizeResponse,
  findOAuthProviderConfig,
  inboxCapabilityPreferenceKey,
  isOAuthProviderAvailable,
  MemberConnectionsResponse,
  OAUTH_PROVIDER_CATALOG,
  type MemberConnectionState,
} from "@workbench/shared";
import {
  enabledUserOAuthInferenceProviders,
  requireOAuthStateSecret,
} from "../config";
import type { HubDb } from "../db";
import {
  isCapabilityAllowedForPrincipal,
  setPrincipalCapabilityGrant,
} from "../lib/capability-grants";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  beginConnect,
  deleteMemberConnection,
  findMemberConnection,
  resolveOAuthClientForProvider,
} from "../lib/oauth-flow";
import type { PendingAuthorizationStore } from "../lib/oauth-flow";
import { ErrorResponse } from "../lib/openapi";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { oauthCallbackRedirectUri } from "../lib/oauth-redirect";

export interface CreateMeConnectionsDeps {
  db: HubDb;
  /** Native grant store — the per-(principal,provider) capability gate is
   * evaluated against the CALLER's own collected grants, not tenant-wide. */
  grantStore: GrantStore;
  pendingStore: PendingAuthorizationStore;
  /** Public base URL of the hub, used to derive the OAuth redirect URI. */
  redirectUriBase: string;
}

// Per-user Settings → Connections surface (CL-3356 pillar A). Lists the
// connectable providers the CALLER is granted (per-principal capability gate,
// fail-closed) with their connected + toggle state, and mints the provider
// authorize URL. The token itself is never read or returned here (write-only/
// masked, like the owner credential surface).
export function createMeConnectionsRouter(
  deps: CreateMeConnectionsDeps,
): Hono<{ Variables: { userId: string } }> {
  const { db, grantStore, pendingStore, redirectUriBase } = deps;
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/connections",
    describeRoute({
      tags: ["Me"],
      summary: "List the caller's connectable providers and connection state",
      responses: {
        200: {
          description: "Connections",
          content: {
            "application/json": {
              schema: resolver(MemberConnectionsResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ connections: [] });

      const stored = await readMemberPreferences(
        db,
        member.tenantId,
        member.principalId,
      );

      const enabledInference = enabledUserOAuthInferenceProviders();
      const connections: MemberConnectionState[] = [];
      for (const cfg of OAUTH_PROVIDER_CATALOG) {
        // Deployment gate before the per-principal gate: a user-self-OAuth
        // inference provider this environment has not enabled is not a
        // connection the member can have, so it is not listed at all.
        if (!isOAuthProviderAvailable(cfg, enabledInference)) continue;

        // Per-principal, fail-closed: a provider the caller is not granted
        // (owner-hidden via member-role deny, or a per-principal deny) is
        // omitted from the caller's surface entirely.
        const allowed = await isCapabilityAllowedForPrincipal(
          grantStore,
          member.tenantId,
          member.principalId,
          cfg.providerName,
        );
        if (!allowed) continue;

        const connection = await findMemberConnection(
          db,
          member.tenantId,
          member.principalId,
          cfg.providerName,
        );
        const toggleKey = inboxCapabilityPreferenceKey(cfg.providerName);
        const redirectUri = oauthCallbackRedirectUri(
          redirectUriBase,
          cfg.providerName,
        );
        const clientConfig = await resolveOAuthClientForProvider(
          db,
          member.tenantId,
          cfg,
          redirectUri,
        );
        connections.push({
          provider: cfg.providerName,
          label: cfg.label,
          connected: connection !== null,
          scopes: connection?.scopes ?? [],
          toggleEnabled: stored[toggleKey] !== false,
          needsReconnect: connection?.needsReconnect ?? false,
          configured: clientConfig !== null,
        });
      }
      return c.json({ connections });
    },
  );

  app.post(
    "/me/connections/:provider/authorize",
    describeRoute({
      tags: ["Me"],
      summary: "Begin the OAuth connect flow for a provider",
      description:
        "Returns the provider authorize URL (PKCE + signed state) the client redirects the user to. 404 if the provider is not connectable, 403 if the caller is not granted the capability, 400 if the provider's OAuth client is not configured.",
      responses: {
        200: {
          description: "Authorize URL",
          content: {
            "application/json": {
              schema: resolver(ConnectionAuthorizeResponse),
            },
          },
        },
        400: {
          description: "Provider OAuth client not configured",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Capability not granted to the caller",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Unknown / non-connectable provider",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const providerName = c.req.param("provider");
      const cfg = findOAuthProviderConfig(providerName);
      if (!cfg) return c.json({ error: "Unknown provider" }, 404);
      // A provider hidden from the listing must also be unreachable by a
      // hand-rolled POST — the gate is enforced, not just rendered.
      if (
        !isOAuthProviderAvailable(cfg, enabledUserOAuthInferenceProviders())
      ) {
        return c.json({ error: "Unknown provider" }, 404);
      }

      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ error: "No provisioned membership" }, 403);

      // Per-principal capability gate, fail-closed: the caller may only begin a
      // connect for a provider they are actually granted.
      const allowed = await isCapabilityAllowedForPrincipal(
        grantStore,
        member.tenantId,
        member.principalId,
        providerName,
      );
      if (!allowed) {
        return c.json({ error: "Capability not available" }, 403);
      }

      let stateSecret: string;
      try {
        stateSecret = requireOAuthStateSecret();
      } catch {
        return c.json(
          { error: "OAuth is not configured on this deployment" },
          400,
        );
      }

      const redirectUri = oauthCallbackRedirectUri(
        redirectUriBase,
        providerName,
      );
      const clientConfig = await resolveOAuthClientForProvider(
        db,
        member.tenantId,
        cfg,
        redirectUri,
      );
      if (!clientConfig) {
        return c.json(
          {
            error: `${cfg.label} OAuth app is not registered — an owner must set its client id and secret on the Capabilities page`,
          },
          400,
        );
      }

      const { redirectUrl } = beginConnect({
        providerConfig: cfg,
        clientConfig,
        tenantId: member.tenantId,
        memberPrincipalId: member.principalId,
        stateSecret,
        pendingStore,
      });
      return c.json({ redirectUrl });
    },
  );

  app.delete(
    "/me/connections/:provider",
    describeRoute({
      tags: ["Me"],
      summary: "Disconnect a provider (delete the member's OAuth credential)",
      description:
        "Removes the caller's principal-owned OAuth credential for the provider and revokes the paired per-principal capability grant, so the capability is no longer usable (least privilege). Idempotent: disconnecting an already-disconnected provider succeeds. 404 for an unknown provider.",
      responses: {
        200: {
          description: "Disconnected (or already disconnected)",
        },
        404: {
          description: "Unknown / non-connectable provider",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const providerName = c.req.param("provider");
      const cfg = findOAuthProviderConfig(providerName);
      if (!cfg) return c.json({ error: "Unknown provider" }, 404);

      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ error: "No provisioned membership" }, 403);

      await deleteMemberConnection(
        db,
        member.tenantId,
        member.principalId,
        providerName,
      );
      // Revoke the self-service capability grant regardless of whether a
      // credential row existed — a disconnect must leave no residual grant.
      await setPrincipalCapabilityGrant(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
        provider: providerName,
        enabled: false,
      });
      return c.json({ disconnected: true });
    },
  );

  return app;
}
