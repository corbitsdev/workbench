// Tenant-scoped credential connect-and-store for the Connections surface:
// `POST /:connectorId/complete` proves a pasted api-key against the
// connector's own probe (CL-6377: one action, not a separate test step
// the client calls first) and, on success, plants the credential through
// the same `ensureProvider` / `ensureCredential` seam `seedCatalog` uses —
// never reimplementing credential storage. A rejected probe 422s with no
// storage, mirroring `@workbench/onboarding`'s `completeCredentialSetup`.
// Mounted inside the platform's native tenant middleware (`TenantEnv`'s
// `tenant`/`principal` resolved before any handler here runs), the same
// way `@corbits/webhook-triggers`' management routes are.
//
// Only api-key connectors are servable here: an unknown connector id, or
// a registry entry with no `probe` (oauth-pkce/oauth-code/webhook-secret,
// display-only in this ticket), is a 404.
import { Hono, type Context } from "hono";
import { type } from "arktype";
import {
  ModelInfo,
  ModelProviderResponse,
  ProviderResponse,
  paginatedSchema,
} from "@intx/types";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { hasUsableModel } from "@corbits/inference-settings";
import { reportError } from "@corbits/error-sink";
import {
  cookiesFromHeader,
  createHubAPI,
  ensureCredential,
  ensureProvider,
  parseAs,
  OLLAMA_PLACEHOLDER_SECRET,
  seedCatalog,
  type ApiCall,
  type EnsureCredentialArgs,
  type EnsureProviderArgs,
  type SeedCatalogArgs,
} from "@workbench/hub-client";
import type { ConnectorDescriptor } from "./descriptor";
import {
  fireConnectedHook,
  fireInferenceCredentialSeedableHook,
  type InferenceCredentialSeedableHook,
  type ServiceConnectedHook,
} from "./connected-hook";
import {
  isInferenceProvider,
  persistConnectorCredential,
} from "./persist-credential";
import type { ProviderHealthStore } from "./provider-health";
import { CONNECTOR_REGISTRY } from "./registry";

export type DisconnectConnectorArgs = {
  readonly tenantId: string;
  readonly connectorId: string;
};

export type DisconnectConnectorResult = {
  /** False when this connector had no provider row to remove — the
   * caller reads that as "already disconnected" and answers 404, never
   * a partial success. */
  readonly disconnected: boolean;
};

/**
 * Undoes exactly what `/complete` (below) and `seedCatalog` planted for a
 * connector, in the one order that satisfies the native schema's foreign
 * keys: the catalog provider row first, then the credential provider row.
 *
 * `model_provider.credential_id` is `ON DELETE RESTRICT`
 * (`vendor/intx/db/migrations`), so a settings-ui disconnect that called
 * `DELETE /credentials/:id` directly 500'd for every inference-provider
 * connector once `seedCatalog` had planted its catalog provider row
 * against that credential — the connect flow worked, the disconnect
 * button never did (CL-6258). Deleting the catalog provider row first
 * clears that reference (and cascades its offerings — `model_offering
 * .providerId` is `ON DELETE CASCADE` — so nothing in
 * `getResolvedCatalog` is ever left resolving to a provider this tenant
 * just disconnected); only then is the credential provider row itself
 * safe to delete, which in turn cascades every credential this connector
 * ever stored (`credential.providerId` is `ON DELETE CASCADE`) — a
 * reconnect can leave more than one, and none should survive.
 *
 * A non-inference connector (Exa, Linear, GitHub, ...) never had a
 * catalog provider row to begin with, so that first delete is a no-op by
 * construction (`catalogProvider === undefined`) and only the second
 * step runs — the same call handles both without a branch on connector
 * kind.
 */
export async function disconnectConnector(
  api: ApiCall,
  cookies: string[],
  args: DisconnectConnectorArgs,
  log: (line: string) => void,
): Promise<DisconnectConnectorResult> {
  const catalogProviders = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    undefined,
    cookies,
  );
  const catalogProviderRows = parseAs(
    paginatedSchema(ModelProviderResponse),
    catalogProviders.data,
    "catalog providers response",
  ).data;
  const catalogProvider = catalogProviderRows.find(
    (row) => row.name === args.connectorId,
  );
  if (catalogProvider !== undefined) {
    const deletedCatalogProvider = await api(
      "DELETE",
      `/api/tenants/${args.tenantId}/catalog/providers/${catalogProvider.id}`,
      undefined,
      cookies,
    );
    if (deletedCatalogProvider.status !== 204) {
      if (deletedCatalogProvider.status !== 404) {
        throw new Error(
          `couldn't remove the catalog provider for ${args.connectorId} (status ${String(deletedCatalogProvider.status)})`,
        );
      }
      log(
        `catalog provider ${args.connectorId} was already removed (concurrent disconnect)`,
      );
    } else {
      log(`removed catalog provider ${args.connectorId} and its offerings`);
    }
  }

  const providers = await api(
    "GET",
    `/api/tenants/${args.tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  const providerRows = parseAs(
    paginatedSchema(ProviderResponse),
    providers.data,
    "providers response",
  ).data;
  const providerRow = providerRows.find((row) => row.name === args.connectorId);
  if (providerRow === undefined) {
    return { disconnected: false };
  }

  const deletedProvider = await api(
    "DELETE",
    `/api/tenants/${args.tenantId}/providers/${providerRow.id}`,
    undefined,
    cookies,
  );
  if (deletedProvider.status !== 204) {
    if (deletedProvider.status !== 404) {
      throw new Error(
        `couldn't remove the provider row for ${args.connectorId} (status ${String(deletedProvider.status)})`,
      );
    }
    log(
      `provider ${args.connectorId} was already removed (concurrent disconnect)`,
    );
    return { disconnected: false };
  }
  log(`removed provider ${args.connectorId} and its credentials`);
  return { disconnected: true };
}

// A connect-time credential test's own failure is, by construction, always
// about the credential a person just pasted — this route's `probe` has no
// other job — so it always classifies as `credential_failure`, never
// `quota_exhausted` (nothing here ever runs real inference, so a quota
// can't even be observed). The probe's own `result.message` (arbitrary
// provider HTTP-body prose — can carry a request URL or a key fragment)
// stays in the 422 response body for the person who just typed the key to
// read; it is never stored in the provider-health record, which a much
// later `GET /provider-health` poll (the shell banner, possibly a
// different session) reads back with no redaction step of its own. See
// `provider-health.ts`'s own header for why.
const CREDENTIAL_TEST_FAILURE_CATEGORY = "credential_failure" as const;

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

// CL-6351: a fresh Ollama connect whose instance has only embedding
// models pulled still succeeds (the URL and instance are real) but has
// no model any workbench turn can actually use — surfaced as a guided
// `modelGuidance` string on an otherwise-normal 200, never as a per-turn
// "does not support generate" failure downstream.
const OLLAMA_NO_CHAT_MODEL_GUIDANCE =
  "Ollama is connected, but no chat model is installed — run `ollama pull qwen3` and try again.";

const SubmitCredential = type({ apiKey: "string > 0" });

export type CreateConnectionRoutesDeps = {
  hubUrl: string;
  requireGrant: RequireGrant;
  log: (line: string) => void;
  /** Test-only override, defaulting to `CONNECTOR_REGISTRY` — lets
   * `routes.test.ts` stub a connector's probe without hitting the real
   * network or reaching for module mocking. */
  registry?: Readonly<Record<string, ConnectorDescriptor>>;
  /** Test-only override, matching `complete-credential.ts`'s `seedCatalogFn`
   * override pattern — lets `routes.test.ts` stub credential storage
   * without reaching for module mocking. */
  ensureProviderFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureProviderArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureProvider>;
  ensureCredentialFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureCredentialArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureCredential>;
  /** Test-only override, matching `complete-credential.ts`'s
   * `seedCatalogFn` override pattern — lets `routes.test.ts` prove an
   * inference-provider connect seeds the catalog (and a non-inference
   * connector never does) without reaching for module mocking. */
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
  /** Test-only override, matching every other override in this file —
   * lets `routes.test.ts` stub the post-connect resolved-catalog read
   * `onInferenceCredentialUsable`'s `hasUsableModel` gate runs against,
   * without reaching for module mocking. */
  getResolvedCatalogFn?: (
    api: ApiCall,
    cookies: string[],
    tenantId: string,
  ) => Promise<readonly ModelInfo[]>;
  /** Test-only override, matching every other override in this file —
   * lets `routes.test.ts` stub disconnect's catalog/provider cleanup
   * without reaching for module mocking. */
  disconnectConnectorFn?: (
    api: ApiCall,
    cookies: string[],
    args: DisconnectConnectorArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof disconnectConnector>;
  /** The env bag an oauth-pkce/oauth-code descriptor's `oauth.clientId(env)`
   * reads a registered app id from (e.g. `{huggingfaceClientId}`) — the
   * same bag `createOAuthConnectRoutes` reads, so `GET /oauth-configured`
   * reports exactly what the connect flow itself would decide. */
  oauthEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * The provider-health signal `GET /provider-health` reads and both
   * `/:connectorId/credential/test` and `/:connectorId/complete` write to
   * (CL-6092): a failing connect-time test marks the connector
   * needs-attention with the closed `credential_failure` category (never
   * the probe's own message — see this module's own
   * `CREDENTIAL_TEST_FAILURE_CATEGORY` comment), a passing one clears it.
   * `/complete` only clears once the credential is durably stored, not on
   * the test pass alone. Absent in tests that don't touch health
   * (matching every other test-only override's optionality) — every
   * write is a no-op when this is undefined.
   */
  providerHealth?: ProviderHealthStore;
  /**
   * Backs `GET /provider-health`'s `connectedProviderCount` — the same
   * `listConnectedProviders` the workbench host's own inference
   * preferences are derived from (`@corbits/chat`). The shell banner
   * uses this to tell "every connected provider needs attention" (route
   * the fix action to Plugins) apart from "nothing is connected at all"
   * (route to onboarding's credential step instead) — see
   * `provider-health.ts`'s own header for why this store alone can't
   * answer that. Omitted from the response (not defaulted to 0) when
   * this dep is absent, so a caller with no wiring never gets a false
   * "zero providers" reading.
   */
  listConnectedProviders?: (tenantId: string) => Promise<readonly string[]>;
  /**
   * Per-connector API base URL override, keyed by connector id — CL-6403's
   * seam letting a fake server stand in for a real provider's production
   * origin in tests/evals (e.g. `{github: "http://localhost:4010"}` for a
   * recorded GitHub fake). Threaded into `descriptor.probe`'s second
   * argument for `/:connectorId/complete`'s PAT check, and stored as the
   * connected provider's `apiBaseUrl` so credential delivery (the sidecar's
   * origin-pinned mediated fetch) targets the same fake. A connector id
   * absent from this map keeps probing and delivering against its own
   * fixed production origin — this is never how a real deployment's
   * providers get configured.
   */
  probeBaseUrls?: Readonly<Record<string, string>>;
  /** Fires once for every durably stored connection, whatever the
   * connector — the composition's connect-settling seam (flip in-room
   * connect cards, resume waiting agents). Failures are logged and
   * never surface into the response. */
  onConnected?: ServiceConnectedHook;
  /** Fires once an inference connector's credential is durably stored
   * AND leaves the tenant with `hasUsableModel` true — never on a
   * non-inference connector, and never merely because a credential row
   * exists (seeding plants that row regardless of whether it actually
   * resolves an offering). The composition wires this to the same
   * durable pending-seed drain onboarding's own credential step feeds,
   * so a provider connected through Settings deploys the tenant's
   * default workflows exactly like one connected through onboarding —
   * see `./connected-hook.ts`. Absent means this hub build never
   * re-seeds off a Settings connect (every existing test double). */
  onInferenceCredentialUsable?: InferenceCredentialSeedableHook;
};

export function createConnectionRoutes(
  deps: CreateConnectionRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const api = createHubAPI(deps.hubUrl);
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const runDisconnectConnector =
    deps.disconnectConnectorFn ?? disconnectConnector;
  const runGetResolvedCatalog =
    deps.getResolvedCatalogFn ??
    (async (resolveApi: ApiCall, cookies: string[], tenantId: string) => {
      const response = await resolveApi(
        "GET",
        `/api/tenants/${tenantId}/models`,
        undefined,
        cookies,
      );
      return parseAs(
        ModelInfo.array(),
        response.data,
        "resolved catalog response",
      );
    });

  // Lets a settings-ui OAuth card tell "not configured" (an operator
  // hasn't registered this connector's OAuth app yet) apart from "not
  // connected" (configured, just not connected by this tenant) before
  // ever rendering a Connect button — see this route's own header. Read
  // access only; no `apiKey`/state to leak, so it needs no stronger a
  // grant than the rest of this tenant-scoped surface already requires.
  app.get(
    "/oauth-configured",
    deps.requireGrant("credential:*", "create"),
    (c) => {
      const oauthEnv = deps.oauthEnv ?? {};
      const configured: Record<string, boolean> = {};
      for (const [id, descriptor] of Object.entries(registry)) {
        if (descriptor.oauth === undefined) continue;
        const hasClientId =
          descriptor.oauth.clientId === undefined ||
          descriptor.oauth.clientId(oauthEnv) !== undefined;
        const hasClientSecret =
          descriptor.oauth.clientSecret === undefined ||
          descriptor.oauth.clientSecret(oauthEnv) !== undefined;
        configured[id] = hasClientId && hasClientSecret;
      }
      return c.json(configured, 200);
    },
  );

  // The shell banner's read (CL-6092): every provider this tenant has
  // marked needs-attention, from either write path (`/complete`'s failing
  // test below, or a classified runtime inference failure reported
  // through `ProviderHealthPort` elsewhere in the hub process). Read-only,
  // so it asks for the grant's `"read"` action rather than the `"create"`
  // this file's other routes require.
  app.get(
    "/provider-health",
    deps.requireGrant("credential:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const providers = deps.providerHealth?.listForTenant(tenant.id) ?? {};
      const connectedProviderCount =
        deps.listConnectedProviders === undefined
          ? undefined
          : (await deps.listConnectedProviders(tenant.id)).length;
      return c.json({ providers, connectedProviderCount }, 200);
    },
  );

  function findApiKeyDescriptor(connectorId: string) {
    const descriptor = registry[connectorId];
    if (descriptor === undefined || descriptor.probe === undefined) {
      return undefined;
    }
    return descriptor;
  }

  async function parseApiKeyBody(c: Context<TenantEnv>) {
    const body: unknown = await c.req.json().catch(() => null);
    return SubmitCredential(body);
  }

  // The PROVIDER row is named by the connector's lowercase `id` — the
  // canonical name `credentialBindings` resolve against via the
  // platform's case-sensitive `resolveProviderByName` (and the same
  // convention onboarding's inference seeding uses). `displayName` is
  // UI-only and must never reach a provider row. The CREDENTIAL row
  // keeps the human-facing displayName; it does not collide with
  // onboarding's seeded `"<id>-default"` name, so reconnecting an
  // inference provider here creates a second row rather than updating
  // the seeded one — accepted for this ticket, not silently papered
  // over.
  app.post(
    "/:connectorId/complete",
    deps.requireGrant("credential:*", "create"),
    async (c) => {
      const connectorId = c.req.param("connectorId");
      const descriptor = findApiKeyDescriptor(connectorId);
      if (descriptor === undefined || descriptor.probe === undefined) {
        return c.json(
          ErrorEnvelope("not_found", `Unknown connector: ${connectorId}`),
          404,
        );
      }

      const parsed = await parseApiKeyBody(c);
      if (parsed instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `An API key is required: ${parsed.summary}`,
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const probeBaseUrl = deps.probeBaseUrls?.[connectorId];
      const test = await descriptor.probe(
        parsed.apiKey,
        probeBaseUrl !== undefined ? { baseUrl: probeBaseUrl } : undefined,
      );
      if (!test.ok) {
        deps.providerHealth?.report(
          tenant.id,
          descriptor.id,
          CREDENTIAL_TEST_FAILURE_CATEGORY,
        );
        return c.json(ErrorEnvelope("invalid_credential", test.message), 422);
      }

      const cookies = cookiesFromHeader(c.req.header("cookie"));
      // A `credentialInputKind: "url"` connector (Ollama) collects a URL
      // in the same wire field every other connector uses for a secret —
      // it stores the fixed placeholder secret instead, and the URL
      // itself as the provider row's `apiBaseUrl` (the same seam MCP
      // servers use). The persist-and-seed sequence itself is the one
      // shared `persistConnectorCredential` every connect surface runs
      // (CL-6394).
      const isUrlCredential = descriptor.credentialInputKind === "url";
      try {
        const { credentialId, seedResult } = await persistConnectorCredential({
          api,
          cookies,
          tenantId: tenant.id,
          descriptor,
          // `test` above already proved `parsed.apiKey` against
          // `descriptor.probe`, so a name conflict on the credential row
          // (a regenerated key, or a retry after a bad paste) is safe to
          // rotate rather than silently keeping the stale secret.
          secret: isUrlCredential ? OLLAMA_PLACEHOLDER_SECRET : parsed.apiKey,
          log: deps.log,
          ...(isUrlCredential
            ? { baseURLOverride: parsed.apiKey }
            : probeBaseUrl !== undefined
              ? { baseURLOverride: probeBaseUrl }
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
        });
        // CL-6351: a fresh Ollama connect whose instance serves no
        // completion-capable model gets guided copy, not a silent dead
        // end — read off the catalog seed the shared persist sequence
        // just ran.
        const modelGuidance =
          descriptor.id === "ollama" &&
          seedResult !== undefined &&
          !seedResult.hasCompletionCapableModel
            ? OLLAMA_NO_CHAT_MODEL_GUIDANCE
            : undefined;
        // Only clear once the credential is actually durable — a storage
        // failure below (the `catch`) must leave a prior needs-attention
        // record standing rather than clearing it on a test pass whose
        // save then failed (CL-6092).
        deps.providerHealth?.clear(tenant.id, descriptor.id);
        await fireConnectedHook(deps.onConnected, deps.log, {
          tenantId: tenant.id,
          principalId: c.get("principal").id,
          connectorId: descriptor.id,
          displayName: descriptor.displayName,
        });
        // A tenant that just connected its own inference provider is an
        // equally valid seed source as an operator-configured hub key —
        // it must not sit unseeded forever waiting on one (CL-6568). Ask
        // the same resolved-catalog question launch itself asks
        // (`hasUsableModel`, `@corbits/inference-settings`) rather than
        // trusting the credential row's mere presence, then hand the
        // provisioning drain this connector's own provider and key —
        // best-effort: a failure here never turns a stored, working
        // credential into a failed connect response.
        if (isInferenceProvider(descriptor.id) && seedResult !== undefined) {
          const user = c.get("user");
          if (user) {
            try {
              const models = await runGetResolvedCatalog(
                api,
                cookies,
                tenant.id,
              );
              if (hasUsableModel(models)) {
                await fireInferenceCredentialSeedableHook(
                  deps.onInferenceCredentialUsable,
                  deps.log,
                  {
                    userId: user.id,
                    tenantId: tenant.id,
                    tenantDomain: tenant.domain,
                    principalId: c.get("principal").id,
                    provider: descriptor.id,
                    apiKey: isUrlCredential
                      ? OLLAMA_PLACEHOLDER_SECRET
                      : parsed.apiKey,
                    ...(isUrlCredential
                      ? { baseURLOverride: parsed.apiKey }
                      : {}),
                  },
                );
              }
            } catch (cause) {
              const message =
                cause instanceof Error ? cause.message : String(cause);
              deps.log(
                `could not check tenant ${tenant.id}'s resolved catalog after connecting ${descriptor.id}; the bench stays as-is until its next reconcile: ${message}`,
              );
            }
          }
        }
        return c.json(
          modelGuidance !== undefined
            ? { credentialId, status: "active" as const, modelGuidance }
            : { credentialId, status: "active" as const },
          200,
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `connection setup failed for connector ${connectorId} on tenant ${tenant.id}: ${message}`,
        );
        return c.json(
          ErrorEnvelope(
            "connection_setup_failed",
            "The key checked out, but saving the connection failed. Try again in a moment.",
          ),
          500,
        );
      }
    },
  );

  // The one disconnect path every settings-ui card (api-key or OAuth)
  // calls — see `disconnectConnector`'s own header for why a direct
  // `DELETE /credentials/:id` from the browser can never do this safely
  // on its own.
  app.delete(
    "/:connectorId/disconnect",
    deps.requireGrant("credential:*", "manage"),
    async (c) => {
      const connectorId = c.req.param("connectorId");
      if (registry[connectorId] === undefined) {
        return c.json(
          ErrorEnvelope("not_found", `Unknown connector: ${connectorId}`),
          404,
        );
      }

      const tenant = c.get("tenant");
      const cookies = cookiesFromHeader(c.req.header("cookie"));
      try {
        const result = await runDisconnectConnector(
          api,
          cookies,
          { tenantId: tenant.id, connectorId },
          deps.log,
        );
        if (!result.disconnected) {
          return c.json(
            ErrorEnvelope("not_found", `${connectorId} is not connected`),
            404,
          );
        }
        return c.body(null, 204);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `disconnect failed for connector ${connectorId} on tenant ${tenant.id}: ${message}`,
        );
        reportError(cause, {
          operation: "disconnect_connector",
          tenantId: tenant.id,
          extra: { connectorId },
        });
        return c.json(
          ErrorEnvelope(
            "disconnect_failed",
            "Couldn't disconnect — try again.",
          ),
          500,
        );
      }
    },
  );

  return app;
}
