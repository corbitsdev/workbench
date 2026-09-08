// The loopback-OAuth half of the Connections surface (CL-7508). Where
// `./oauth-routes.ts` drives the flows whose browser returns to the hub,
// the `oauth-loopback` connectors (codex, xai-oauth) cannot: their
// authorization servers only accept the fixed loopback redirect URIs the
// providers' own CLIs register, so the callback listener lives on the
// sidecar's machine and is reached through the sidecar ws channel
// (`oauth.login.start` / `oauth.login.result`).
//
// One POST per connector: gate through the router's locality policy (a
// remote sidecar's loopback opens on the wrong machine — no local sidecar
// resolves the typed gate outcome, never a hub-hosted fallback), return
// the authorize URL for the web UI to navigate, and persist the finished
// tokens through the one shared connect sequence
// (`./persist-credential.ts`) when the sidecar's terminal result frame
// lands. The terminal frame arrives after this response, so the persist
// runs detached: failures are reported, never silently dropped, and a
// caller that needs the outcome re-checks the connection list.
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createHubAPI } from "@corbits/hub-api-client";
import { reportError } from "@corbits/error-sink";
import type { OAuthLoginRequestOutcome } from "@intx/hub-sessions";
import type { ConnectorDescriptor } from "./descriptor";
import {
  persistConnectorCredential,
  type PersistConnectorCredentialFns,
} from "./persist-credential";

export type CreateOAuthLoopbackRoutesDeps = PersistConnectorCredentialFns & {
  readonly hubUrl: string;
  readonly log: (line: string) => void;
  /** The connector set this build ships — this package carries none of
   * its own (CL-7384), so a caller always supplies one. */
  readonly registry: Readonly<Record<string, ConnectorDescriptor>>;
  /** The sidecar router's gated login starter; the hub wiring supplies
   * it bound to its locality policy. */
  readonly requestOAuthLogin: (args: {
    connectorId: "codex" | "xai-oauth";
  }) => Promise<OAuthLoginRequestOutcome>;
  /** Cleared on a successful connect, same store the other connect
   * surfaces share (CL-6092). */
  readonly providerHealth?: {
    clear(tenantId: string, connectorId: string): void;
  };
  /** Fired once the terminal result persisted, mirroring the other
   * connect surfaces' `onConnected`. */
  readonly onConnected?: (info: {
    tenantId: string;
    connectorId: string;
    displayName: string;
  }) => Promise<void> | void;
};

export function isLoopbackConnectorId(
  connectorId: string,
): connectorId is "codex" | "xai-oauth" {
  return connectorId === "codex" || connectorId === "xai-oauth";
}

export function createOAuthLoopbackRoutes(
  deps: CreateOAuthLoopbackRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const api = createHubAPI(deps.hubUrl);

  app.post("/:connectorId/loopback", async (c) => {
    const connectorId = c.req.param("connectorId");
    const descriptor = deps.registry[connectorId];
    if (
      descriptor === undefined ||
      descriptor.authKind !== "oauth-loopback" ||
      descriptor.oauth === undefined ||
      !isLoopbackConnectorId(connectorId)
    ) {
      return c.json(
        {
          ok: false,
          reason: "unsupported",
          message: `${connectorId} is not a loopback-OAuth connector`,
        },
        404,
      );
    }
    const tenant = c.get("tenant");
    const cookies =
      c.req
        .header("cookie")
        ?.split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => cookie.length > 0) ?? [];

    let outcome: OAuthLoginRequestOutcome;
    try {
      outcome = await deps.requestOAuthLogin({ connectorId });
    } catch (cause) {
      // report-error-ignore: a failed login start is surfaced to the caller
      // through this route's own typed error body, so a report-error sink
      // entry would double-report the same failure.
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `loopback login for ${connectorId} on tenant ${tenant.id} failed to start: ${message}`,
      );
      return c.json({ ok: false, reason: "error", message }, 502);
    }
    if (outcome.status === "gate") {
      return c.json(
        { ok: false, reason: "gate", message: outcome.message },
        409,
      );
    }
    if (outcome.status === "error") {
      return c.json(
        { ok: false, reason: "error", message: outcome.message },
        502,
      );
    }

    // The terminal frame lands after this response: persist detached, but
    // never silently.
    void outcome.completed
      .then(async (final) => {
        if (final.status === "error") {
          deps.log(
            `loopback login ${outcome.requestId} for ${connectorId} failed: ${final.message}`,
          );
          return;
        }
        const tokens = final.tokens;
        // The derived account label is the only id_token-derived material
        // that persists: it is a public label, while the raw id_token is a
        // bearer-adjacent secret and metadata is stored unencrypted — so the
        // id_token never goes there. The expiry is a first-class COLUMN
        // (serving-time refresh keys on it), never metadata.
        const credentialMetadata: Record<string, unknown> = {
          ...(tokens.accountId !== undefined
            ? { accountId: tokens.accountId }
            : {}),
        };
        await persistConnectorCredential({
          api,
          cookies,
          tenantId: tenant.id,
          descriptor,
          secret: tokens.access,
          credentialMetadata,
          ...(tokens.refresh !== undefined
            ? { refreshSecret: tokens.refresh }
            : {}),
          ...(tokens.expiresAt !== undefined
            ? { expiresAt: new Date(tokens.expiresAt).toISOString() }
            : {}),
          ...(deps.ensureProviderFn !== undefined
            ? { ensureProviderFn: deps.ensureProviderFn }
            : {}),
          ...(deps.ensureCredentialFn !== undefined
            ? { ensureCredentialFn: deps.ensureCredentialFn }
            : {}),
          ...(deps.seedCatalogFn !== undefined
            ? { seedCatalogFn: deps.seedCatalogFn }
            : {}),
          log: deps.log,
        });
        deps.providerHealth?.clear(tenant.id, connectorId);
        await deps.onConnected?.({
          tenantId: tenant.id,
          connectorId,
          displayName: descriptor.displayName,
        });
        deps.log(`connected ${connectorId} for tenant ${tenant.id}`);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `loopback login ${outcome.requestId} for ${connectorId} failed to persist: ${message}`,
        );
        reportError(cause, {
          operation: "persist_loopback_oauth_connection",
          tenantId: tenant.id,
          extra: { connectorId },
        });
      });

    return c.json({
      ok: true,
      requestId: outcome.requestId,
      authorizeUrl: outcome.authorizeUrl,
    });
  });

  return app;
}
