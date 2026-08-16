// Tenant-scoped credential test-and-store for the Connections surface:
// `POST /:connectorId/credential/test` proves a pasted api-key against
// the connector's own probe with no storage, `POST /:connectorId/complete`
// re-proves it (never trusting a client-side "already tested" claim,
// mirroring `@workbench/onboarding`'s `completeCredentialSetup`) and, on
// success, plants the credential through the same `ensureProvider` /
// `ensureCredential` seam `seedCatalog` uses — never reimplementing
// credential storage. Mounted inside the platform's native tenant
// middleware (`TenantEnv`'s `tenant`/`principal` resolved before any
// handler here runs), the same way `@corbits/webhook-triggers`'
// management routes are.
//
// Only api-key connectors are servable here: an unknown connector id, or
// a registry entry with no `probe` (oauth-pkce/oauth-code/webhook-secret,
// display-only in this ticket), is a 404.
import { Hono, type Context } from "hono";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import {
  createHubAPI,
  ensureCredential,
  ensureProvider,
  type ApiCall,
  type EnsureCredentialArgs,
  type EnsureProviderArgs,
} from "@workbench/hub-client";
import type { ConnectorDescriptor } from "./descriptor";
import type { ProviderHealthStore } from "./provider-health";
import { CONNECTOR_REGISTRY } from "./registry";

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

const SubmitCredential = type({ apiKey: "string > 0" });

function cookiesFromHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
}

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
   * `listConnectedProviders` the channel host's own inference
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
};

export function createConnectionRoutes(
  deps: CreateConnectionRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const api = createHubAPI(deps.hubUrl);
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  const runEnsureProvider = deps.ensureProviderFn ?? ensureProvider;
  const runEnsureCredential = deps.ensureCredentialFn ?? ensureCredential;

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
        configured[id] =
          descriptor.oauth.clientId === undefined ||
          descriptor.oauth.clientId(oauthEnv) !== undefined;
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

  app.post(
    "/:connectorId/credential/test",
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
      const result = await descriptor.probe(parsed.apiKey);
      if (!result.ok) {
        deps.providerHealth?.report(
          tenant.id,
          descriptor.id,
          CREDENTIAL_TEST_FAILURE_CATEGORY,
        );
        return c.json(ErrorEnvelope("invalid_credential", result.message), 422);
      }
      // A passing test here is a genuine, if lighter-weight, proof the
      // credential works — the same signal `/complete`'s own passing test
      // clears on (CL-6092): never a reply's prose, always a real probe.
      deps.providerHealth?.clear(tenant.id, descriptor.id);
      return c.json({ ok: true }, 200);
    },
  );

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
      const test = await descriptor.probe(parsed.apiKey);
      if (!test.ok) {
        deps.providerHealth?.report(
          tenant.id,
          descriptor.id,
          CREDENTIAL_TEST_FAILURE_CATEGORY,
        );
        return c.json(ErrorEnvelope("invalid_credential", test.message), 422);
      }

      const cookies = cookiesFromHeader(c.req.header("cookie"));
      try {
        const providerId = await runEnsureProvider(
          api,
          cookies,
          {
            tenantId: tenant.id,
            name: descriptor.id,
            plugin: descriptor.credentialPlugin,
          },
          deps.log,
        );
        const credentialId = await runEnsureCredential(
          api,
          cookies,
          {
            tenantId: tenant.id,
            providerId,
            name: descriptor.displayName,
            secret: parsed.apiKey,
            type: "api_key",
          },
          deps.log,
        );
        // Only clear once the credential is actually durable — a storage
        // failure below (the `catch`) must leave a prior needs-attention
        // record standing rather than clearing it on a test pass whose
        // save then failed (CL-6092).
        deps.providerHealth?.clear(tenant.id, descriptor.id);
        return c.json({ credentialId, status: "active" as const }, 200);
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

  return app;
}
