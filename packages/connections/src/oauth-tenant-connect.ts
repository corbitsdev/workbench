// The `connectCredential` wiring `apps/hub` needs to mount
// `createOAuthConnectRoutes` (`./oauth-routes.ts`) directly beside its
// tenant-scoped `createConnectionRoutes` (`./routes.ts`), rather than
// only reachable through `packages/onboarding`'s own first-login mount.
// Where onboarding resolves "the user's personal tenant" from scratch
// (no tenant exists yet at first login), this caller already runs
// inside the platform's tenant middleware — the same one
// `createConnectionRoutes` and `createMcpOAuthRoutes` (#115) run
// inside — so `c.get("tenant")`/`c.get("principal")` are already
// resolved and this never re-derives a tenant of its own.
//
// Persists exactly the way `routes.ts`'s `POST /:connectorId/complete`
// does: `ensureProvider` + `ensureCredential`, then `seedCatalog` for an
// inference connector so a just-connected provider's models are
// launchable immediately, not just stored. The credential is already
// proven by the OAuth exchange itself, so there is no separate probe
// step here (unlike `/complete`'s pasted-key path, which has nothing
// else vouching for the secret).
import type { Context } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  createHubAPI,
  ensureCredential,
  ensureProvider,
  PROVIDER_TEST_CONFIG,
  seedCatalog,
  type ApiCall,
  type EnsureCredentialArgs,
  type EnsureProviderArgs,
  type SeedCatalogArgs,
  type SupportedCredentialProvider,
} from "@workbench/hub-client";
import type { ConnectorDescriptor } from "./descriptor";
import type { ProviderHealthStore } from "./provider-health";
import { CONNECTOR_REGISTRY } from "./registry";
import type { CreateOAuthConnectRoutesDeps } from "./oauth-routes";

export type CreateTenantConnectCredentialDeps = {
  readonly hubUrl: string;
  readonly log: (line: string) => void;
  /** Test-only override, matching every other route factory here. */
  readonly registry?: Readonly<Record<string, ConnectorDescriptor>>;
  /** Cleared on a successful connect, same store `createConnectionRoutes`'
   * `/complete` and `GET /provider-health` share (CL-6092). */
  readonly providerHealth?: ProviderHealthStore;
  /** Test-only override, matching `routes.ts`'s own seam — lets this
   * module's own test prove the persist/seed sequencing without
   * reaching for module mocking or a real hub HTTP server. */
  readonly ensureProviderFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureProviderArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureProvider>;
  readonly ensureCredentialFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureCredentialArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureCredential>;
  readonly seedCatalogFn?: (
    args: SeedCatalogArgs,
  ) => ReturnType<typeof seedCatalog>;
};

function isInferenceProvider(id: string): id is SupportedCredentialProvider {
  return Object.hasOwn(PROVIDER_TEST_CONFIG, id);
}

/**
 * Builds the `connectCredential` dep `createOAuthConnectRoutes` needs,
 * scoped to whatever tenant the request's own middleware already
 * resolved. `args.c` is cast to `Context<TenantEnv>` — safe only
 * because this is wired exclusively into a mount reached through the
 * platform's tenant middleware (see this module's own header); a caller
 * mounting outside that middleware must not use this.
 */
export function createTenantConnectCredential(
  deps: CreateTenantConnectCredentialDeps,
): CreateOAuthConnectRoutesDeps["connectCredential"] {
  const api = createHubAPI(deps.hubUrl);
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const runEnsureProvider = deps.ensureProviderFn ?? ensureProvider;
  const runEnsureCredential = deps.ensureCredentialFn ?? ensureCredential;
  const runSeedCatalog = deps.seedCatalogFn ?? seedCatalog;

  return async (args) => {
    const c = args.c as Context<TenantEnv>;
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const descriptor = registry[args.connectorId];
    if (descriptor === undefined) {
      return {
        kind: "invalid-credential",
        message: `Unknown connector: ${args.connectorId}`,
      };
    }

    try {
      const providerId = await runEnsureProvider(
        api,
        args.cookies,
        {
          tenantId: tenant.id,
          name: descriptor.id,
          plugin: descriptor.credentialPlugin,
        },
        deps.log,
      );
      await runEnsureCredential(
        api,
        args.cookies,
        {
          tenantId: tenant.id,
          providerId,
          name: descriptor.displayName,
          secret: args.apiKey,
          type: "api_key",
          verified: true,
        },
        deps.log,
      );
      if (isInferenceProvider(descriptor.id)) {
        await runSeedCatalog({
          api,
          cookies: args.cookies,
          tenantId: tenant.id,
          log: deps.log,
          provider: descriptor.id,
          apiKey: args.apiKey,
          credentialVerified: true,
        });
      }
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
      return { kind: "invalid-credential", message };
    }
  };
}
