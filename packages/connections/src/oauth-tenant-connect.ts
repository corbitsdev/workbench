// The `connectCredential` wiring `apps/hub` needs to mount
// `createOAuthConnectRoutes` (`./oauth-routes.ts`) directly beside its
// tenant-scoped `createConnectionRoutes` (`./routes.ts`), rather than
// only reachable through `packages/onboarding`'s own first-login mount.
// Where onboarding resolves "the user's personal tenant" from scratch
// (no tenant exists yet at first login), this caller already runs
// inside the platform's tenant middleware — the same one
// `createConnectionRoutes` and `createMcpOAuthRoutes` (#115) run
// inside — so `c.get("tenant")`/`c.get("principal")` are already
// resolved, typed by the factory's own `TenantEnv` parameter rather
// than a cast.
//
// Persists through the one shared sequence every connect surface runs
// (`./persist-credential.ts`): provider + credential rows always, the
// curated model catalog only for an inference connector — a
// non-inference connector (GitHub) stores its token and stops there.
// The credential is already proven by the OAuth exchange itself, so
// there is no separate probe step here (unlike `/complete`'s pasted-key
// path, which has nothing else vouching for the secret).
import type { TenantEnv } from "@intx/hub-api";
import { createHubAPI } from "@workbench/hub-client";
import { reportError } from "@corbits/error-sink";
import type { ConnectorDescriptor } from "./descriptor";
import type { ProviderHealthStore } from "./provider-health";
import { CONNECTOR_REGISTRY } from "./registry";
import type { CreateOAuthConnectRoutesDeps } from "./oauth-routes";
import {
  persistConnectorCredential,
  type PersistConnectorCredentialFns,
} from "./persist-credential";

export type CreateTenantConnectCredentialDeps =
  PersistConnectorCredentialFns & {
    readonly hubUrl: string;
    readonly log: (line: string) => void;
    /** Test-only override, matching every other route factory here. */
    readonly registry?: Readonly<Record<string, ConnectorDescriptor>>;
    /** Cleared on a successful connect, same store `createConnectionRoutes`'
     * `/complete` and `GET /provider-health` share (CL-6092). */
    readonly providerHealth?: ProviderHealthStore;
  };

/**
 * Builds the `connectCredential` dep a `TenantEnv`-typed
 * `createOAuthConnectRoutes` mount needs, scoped to whatever tenant the
 * request's own middleware already resolved.
 */
export function createTenantConnectCredential(
  deps: CreateTenantConnectCredentialDeps,
): CreateOAuthConnectRoutesDeps<TenantEnv>["connectCredential"] {
  const api = createHubAPI(deps.hubUrl);
  const registry = deps.registry ?? CONNECTOR_REGISTRY;

  return async (args) => {
    const tenant = args.c.get("tenant");
    const principal = args.c.get("principal");
    const descriptor = registry[args.connectorId];
    if (descriptor === undefined) {
      return {
        kind: "invalid-credential",
        message: `Unknown connector: ${args.connectorId}`,
      };
    }

    try {
      const persistArgs: Parameters<typeof persistConnectorCredential>[0] = {
        api,
        cookies: args.cookies,
        tenantId: tenant.id,
        descriptor,
        secret: args.apiKey,
        log: deps.log,
        ...(args.credentialMetadata !== undefined
          ? { credentialMetadata: args.credentialMetadata }
          : {}),
        ...(args.refreshToken !== undefined
          ? { refreshSecret: args.refreshToken }
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
      };
      await persistConnectorCredential(persistArgs);
      deps.providerHealth?.clear(tenant.id, descriptor.id);
      return {
        kind: "connected",
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        principalId: principal.id,
        tenantDomain: tenant.domain,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `oauth connect for ${args.connectorId} on tenant ${tenant.id} failed to persist: ${message}`,
      );
      reportError(cause, {
        operation: "persist_tenant_oauth_connection",
        tenantId: tenant.id,
        extra: { connectorId: args.connectorId },
      });
      return { kind: "invalid-credential", message };
    }
  };
}
