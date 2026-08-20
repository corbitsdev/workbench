// The guided credential step of first-run: a signed-in user who reached
// onboarding with no seed model configured picks a provider — any of
// `supportedCredentialProviders()` — and pastes their own key. CL-6123
// dropped the blocking probe that used to sit in front of this: an
// onboarding submission is accepted and stored immediately, with no
// live call to the provider gating it. A key that turns out to be wrong
// is caught later, the first time it is actually dialed for real
// inference, and surfaces in-chat through the existing credential-error
// + "Fix this connection" flow (CL-6092) — that is the designed place to
// catch a bad key, not a synchronous check onboarding makes someone wait
// on. Storing plants the credential and its catalog through the hub's
// native `POST /api/tenants/:id/credentials` route (see `seedCatalog`'s
// `ensureCredential`) — this module never stores a secret itself — the
// same `seedCatalog` + `seedTenant` the first-login hook runs when a
// hub-owned key is configured, so a self-served key and an
// operator-configured one land the same bench.
//
// Two halves, on purpose. `testAndPersistCredential` — the fast half —
// plants the credential and its catalog; it is the only half an OAuth
// callback route runs before redirecting, because nothing in it ever
// deploys a workflow. `ensureSeeded` — the slow half — is the
// workflow-deploy step that used to run inline in the same request:
// minutes of deploy calls a browser had no business waiting on
// mid-redirect. A pasted-key submission (`/complete`, a plain fetch, not
// a redirect the browser can double-fire) still runs both halves
// synchronously through `completeCredentialSetup` below, unchanged.
//
// `ensureSeeded` runs with `confirmDeployments: false`: there is nothing
// to confirm by triggering a real, billed inference call against an
// account whose key was never probed — only insufficient credit, a bad
// key, or a busy sidecar for `confirmDeployments: true` to fail
// spuriously on. Deployment itself still runs (it is configuration, not
// inference), so the bench's default workflows are genuinely usable
// once this returns; whether the key actually works is proven the first
// time a workflow really dials it.
//
// The workflows deploy against the connected provider's own default
// model — read straight out of `CATALOG_SEEDS` (`catalog-seed-data.ts`),
// the one place a provider's curated model list is declared, rather than
// a second, hand-maintained model choice living here. This is also what
// recovers a bench the hub's own sign-in hook
// (`provisionPersonalTenantIfNeeded`) could only mark `bench_unseeded`
// (no hub-owned `ANTHROPIC_API_KEY` to seed with): the first working
// credential a user connects — through this module, whichever
// onboarding path reaches it — finishes seeding with that credential's
// own provider, so an OAuth-only or bring-your-own-key user is never
// stuck waiting on an operator-configured key.

import { PrincipalSummary, TenantResponse, paginatedSchema } from "@intx/types";
import {
  CATALOG_SEEDS,
  DEFAULT_WORKFLOWS,
  isSidecarUnavailableError,
  ollamaOpenAICompatBaseURL,
  parseAs,
  seedCatalog,
  seedTenant,
  supportedCredentialProviders,
  type ApiCall,
  type ModelSource,
  type SeedCatalogArgs,
  type SeedTenantArgs,
  type SupportedCredentialProvider,
  type ToolRegistryPublisher,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { personalTenantSlug, seededWorkflowStatus } from "./provision";

/** The onboarding UI's copy for a partial seed: every durable step
 * (credential, tenant, grants, assets) already succeeded, and the
 * deferred workflows finish deploying on their own the next time this
 * account's onboarding page reads `POST /complete-setup` — see
 * `ensureSeeded`'s own doc comment below for the sidecar-unavailable
 * class this covers. */
export const AGENTS_PENDING_MESSAGE =
  "Your workbench is ready — agents will come online shortly.";

export type PersonalTenant = {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly principalId: string;
  readonly tenantDomain: string;
};

export type TestAndPersistCredentialResult =
  /**
   * Kept for API compatibility with dependents that accept it as a
   * possible outcome (`@workbench/connections`' `OAuthStoreOutcome`,
   * matched "exactly" per that module's own doc comment) — the default
   * implementation below never produces it, since CL-6123 dropped the
   * probe that used to be the only thing that could.
   */
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" }
  | ({ readonly kind: "connected" } & PersonalTenant);

export type EnsureSeededResult =
  | { readonly kind: "seeded"; readonly workflows: string[] }
  /**
   * The deploy step hit the sidecar-unavailable class specifically
   * (CL-6264): every durable step ahead of it (credential, tenant,
   * grants, catalog, workflow assets) is intact, `deployed` names the
   * default workflows that made it live before the sidecar dropped out,
   * and `pending` names the rest. Never produced for any other deploy
   * failure — those still throw, same as before.
   */
  | {
      readonly kind: "seeded-pending-agents";
      readonly deployed: string[];
      readonly pending: string[];
      readonly message: string;
    };

export type CompleteCredentialResult =
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" }
  | {
      readonly kind: "seeded";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly workflows: string[];
    }
  | {
      readonly kind: "seeded-pending-agents";
      readonly tenantId: string;
      readonly tenantSlug: string;
      /** Threaded through to `routes.ts`'s `/complete` handler, which
       * writes them into the same `pendingSeedStore` row an OAuth
       * connect writes (see `./pending-seed.ts`) so `POST
       * /complete-setup`'s existing retry path — no new queue — finishes
       * the deferred workflows on this account's next onboarding-page
       * visit. */
      readonly principalId: string;
      readonly tenantDomain: string;
      readonly deployed: string[];
      readonly pending: string[];
      readonly message: string;
    };

type CommonArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  pushWorkflow: WorkflowPusher;
  /** Passed through to `seedTenant`; a test double replaces the real corbits-tools publish the same way `pushWorkflow` replaces the real git push. */
  publishToolRegistry?: ToolRegistryPublisher;
  log: (line: string) => void;
};

export type TestAndPersistCredentialArgs = CommonArgs & {
  userId: string;
  userEmail: string;
  provider: SupportedCredentialProvider;
  apiKey: string;
  /**
   * Free-form data stored on the credential's `metadata` field — the
   * extension point an OAuth connect flow's token expiry lives in (see
   * `huggingface-connect.ts`'s `exchangeCodeForToken`). Absent for a
   * pasted key or a durable-key connect flow (OpenRouter).
   */
  credentialMetadata?: Record<string, unknown>;
  /** The configurable-base-URL seam `ollama` uses (see `modelSourceFor`);
   * ignored for every other provider. */
  baseURLOverride?: string;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
};

export type EnsureSeededArgs = CommonArgs & {
  tenant: PersonalTenant;
  provider: SupportedCredentialProvider;
  apiKey: string;
  baseURLOverride?: string;
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
};

export type CompleteCredentialArgs = CommonArgs & {
  userId: string;
  userEmail: string;
  provider: SupportedCredentialProvider;
  apiKey: string;
  credentialMetadata?: Record<string, unknown>;
  baseURLOverride?: string;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
};

/**
 * The exact name the Plugins gallery's resolver
 * (`@workbench/connections/plugins`'s `resolveOne`) looks a credential up
 * by: a connector's `descriptor.displayName`, itself sourced from this
 * same `PROVIDER_TEST_CONFIG` table (see `packages/connections/src/
 * registry.ts`). Seeding the credential under any other name — the
 * catalog-seed convention `inferenceCredentialName` still uses for the
 * hub-owned CLI seed and the env-key auto-plant — leaves a self-served
 * connect flow's credential invisible to that gallery.
 */
function credentialDisplayName(provider: SupportedCredentialProvider): string {
  const match = supportedCredentialProviders().find((p) => p.id === provider);
  if (match === undefined) {
    throw new Error(`No display name registered for provider ${provider}`);
  }
  return match.displayName;
}

export async function findPersonalTenant(
  api: ApiCall,
  cookies: string[],
  expectedSlug: string,
): Promise<PersonalTenant | undefined> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  const own = summary.data.find((p) => p.tenantSlug === expectedSlug);
  if (!own) return undefined;

  const tenantResponse = await api(
    "GET",
    `/api/tenants/${own.tenantId}`,
    undefined,
    cookies,
  );
  const tenant = parseAs(
    TenantResponse,
    tenantResponse.data,
    "tenant response",
  );
  return {
    tenantId: own.tenantId,
    tenantSlug: own.tenantSlug,
    principalId: own.principalId,
    tenantDomain: tenant.domain,
  };
}

/** The `ModelSource` `ensureSeeded` deploys every default workflow
 * against: the connected provider's own curated default model
 * (`CATALOG_SEEDS`), paired with the plaintext key stored for that same
 * provider — never probed against it before this point. `baseURLOverride`
 * is the configurable-base-URL seam every provider but `ollama` ignores
 * (a fixed origin); for `ollama` it is the root the person actually
 * pointed their instance at, normalized to the OpenAI-compatible `/v1`
 * form this deploys against. */
export function modelSourceFor(
  provider: SupportedCredentialProvider,
  apiKey: string,
  baseURLOverride?: string,
): ModelSource {
  const catalogSeed = CATALOG_SEEDS[provider];
  const defaultModel = catalogSeed.models[0];
  if (defaultModel === undefined) {
    throw new Error(
      `catalog seed for provider ${provider} has no default model`,
    );
  }
  const baseURL =
    provider === "ollama"
      ? ollamaOpenAICompatBaseURL(
          baseURLOverride ?? catalogSeed.provider.baseURL,
        )
      : catalogSeed.provider.baseURL;
  return {
    provider: catalogSeed.provider.plugin,
    model: defaultModel.canonicalName,
    baseURL,
    apiKey,
  };
}

/**
 * The fast half: plants an onboarding user's key as a credential on
 * their own personal bench, alongside that provider's curated model
 * catalog — immediately, with no live call to the provider gating it
 * (CL-6123). Never deploys a workflow — that is `ensureSeeded`'s job,
 * deliberately kept out of this half so an OAuth callback route can run
 * only this and redirect immediately.
 */
export async function testAndPersistCredential(
  args: TestAndPersistCredentialArgs,
): Promise<TestAndPersistCredentialResult> {
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;

  const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
  const tenant = await findPersonalTenant(args.api, args.cookies, expectedSlug);
  if (!tenant) return { kind: "no-personal-bench" };

  const seedCatalogArgs = {
    api: args.api,
    cookies: args.cookies,
    tenantId: tenant.tenantId,
    provider: args.provider,
    apiKey: args.apiKey,
    log: args.log,
    credentialName: credentialDisplayName(args.provider),
    credentialType:
      args.credentialMetadata !== undefined
        ? ("oauth_token" as const)
        : ("api_key" as const),
    // An explicit user submission through a connect UI — a pasted key or
    // a completed OAuth exchange — always rotates a name-conflicting
    // api_key credential (a regenerated key, or a retry after a bad
    // paste), independent of whether the key was ever probed: see
    // `ensureCredential`'s own `verified` doc comment in
    // `@workbench/hub-client`'s `seed.ts` for the full rotation rule.
    credentialVerified: true,
  };
  const withMetadata =
    args.credentialMetadata !== undefined
      ? { ...seedCatalogArgs, credentialMetadata: args.credentialMetadata }
      : seedCatalogArgs;
  await runSeedCatalog(
    args.baseURLOverride !== undefined
      ? { ...withMetadata, baseURLOverride: args.baseURLOverride }
      : withMetadata,
  );

  return { kind: "connected", ...tenant };
}

/**
 * The slow half: deploys and — never confirms, see the module comment —
 * every default workflow against the tenant's already-persisted
 * credential. Safe to call more than once for the same tenant: every
 * step it drives (`seedTenant`'s asset and deployment creation) is
 * itself ensure-then-create, so two overlapping calls (a duplicate
 * "finish setup" request, a retried one) never double-deploy.
 *
 * CL-6264: a deploy failure in the sidecar-unavailable class specifically
 * (`isSidecarUnavailableError`, the 502 `ensureDeployment` raises when
 * the hub cannot reach the sidecar) does not fail this call — every step
 * ahead of the deploy loop already durably succeeded, and the sidecar
 * coming back is an operational fact outside the caller's control, not
 * a reason to tell someone their onboarding failed. `seededWorkflowStatus`
 * re-reads the tenant's actual asset/deployment state (rather than
 * hand-tracking a loop index) to report exactly which default workflows
 * made it live and which are still pending. Any other error out of
 * `seedTenant` still throws, unchanged.
 */
export async function ensureSeeded(
  args: EnsureSeededArgs,
): Promise<EnsureSeededResult> {
  const runSeedTenant = args.seedTenantFn ?? seedTenant;

  const seedTenantArgs = {
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    tenant: {
      tenantId: args.tenant.tenantId,
      principalId: args.tenant.principalId,
      domain: args.tenant.tenantDomain,
    },
    model: modelSourceFor(args.provider, args.apiKey, args.baseURLOverride),
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
    confirmDeployments: false,
  };
  try {
    await runSeedTenant(
      args.publishToolRegistry !== undefined
        ? { ...seedTenantArgs, publishToolRegistry: args.publishToolRegistry }
        : seedTenantArgs,
    );
  } catch (cause) {
    if (!isSidecarUnavailableError(cause)) throw cause;
    args.log(
      `sidecar unavailable while deploying default workflows for tenant ${args.tenant.tenantId}; completing onboarding with agents pending: ${cause.message}`,
    );
    const { deployed, pending } = await seededWorkflowStatus(
      args.api,
      args.cookies,
      args.tenant.tenantId,
    );
    return {
      kind: "seeded-pending-agents",
      deployed,
      pending,
      message: AGENTS_PENDING_MESSAGE,
    };
  }

  return {
    kind: "seeded",
    workflows: DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName),
  };
}

/**
 * The synchronous, single-request path a pasted-key submission
 * (`POST /complete`) still takes: fast half then slow half, back to
 * back. Unlike an OAuth callback's redirect, a `/complete` fetch is a
 * single explicit submit the browser does not double-fire, so there is
 * no double-request hazard to split around here.
 */
export async function completeCredentialSetup(
  args: CompleteCredentialArgs,
): Promise<CompleteCredentialResult> {
  const persisted = await testAndPersistCredential(args);
  if (persisted.kind !== "connected") return persisted;

  const baseEnsureSeededArgs = {
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    tenant: persisted,
    provider: args.provider,
    apiKey: args.apiKey,
  };
  const ensureSeededArgs =
    args.baseURLOverride !== undefined
      ? { ...baseEnsureSeededArgs, baseURLOverride: args.baseURLOverride }
      : baseEnsureSeededArgs;
  const withPublishToolRegistry =
    args.publishToolRegistry !== undefined
      ? { ...ensureSeededArgs, publishToolRegistry: args.publishToolRegistry }
      : ensureSeededArgs;
  const seeded = await ensureSeeded(
    args.seedTenantFn !== undefined
      ? { ...withPublishToolRegistry, seedTenantFn: args.seedTenantFn }
      : withPublishToolRegistry,
  );

  if (seeded.kind === "seeded-pending-agents") {
    return {
      kind: "seeded-pending-agents",
      tenantId: persisted.tenantId,
      tenantSlug: persisted.tenantSlug,
      principalId: persisted.principalId,
      tenantDomain: persisted.tenantDomain,
      deployed: seeded.deployed,
      pending: seeded.pending,
      message: seeded.message,
    };
  }

  return {
    kind: "seeded",
    tenantId: persisted.tenantId,
    tenantSlug: persisted.tenantSlug,
    workflows: seeded.workflows,
  };
}
