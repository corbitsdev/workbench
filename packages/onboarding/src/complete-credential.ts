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
// plants the credential and its catalog; nothing in it ever deploys a
// workflow, so it is all any connect route runs before answering.
// `ensureSeeded` — the slow half — is the workflow-deploy step, minutes
// of deploy calls no browser has any business waiting on.
//
// CL-6457 finished that split: NO HTTP route runs the slow half any
// more. Connecting a provider persists the credential, seeds its
// catalog, and returns in seconds; the deploys belong to the background
// drain in `./bench-provisioning.ts`, which is also what makes them
// survive a hub restart. `completeCredentialSetup` at the bottom of this
// file still composes both halves back-to-back, but it is an
// eval-harness convenience — a bench that must be fully deployed before
// a scenario runs — and never the connect path. A route that calls it
// re-creates the 2+ minute "Connecting…" freeze this split exists to
// prevent.
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

import {
  ModelInfo,
  ModelResponse,
  PrincipalSummary,
  TenantResponse,
  paginatedSchema,
} from "@intx/types";
import {
  ollamaOpenAICompatBaseURL,
  type SupportedCredentialProvider,
} from "@corbits/connections/credential-test";
import { preferCompletionCapable } from "@corbits/connections/model-capability";
import {
  CATALOG_SEEDS,
  DEFAULT_WORKFLOWS,
  seedTenant,
  type ModelSource,
  type SeedTenantArgs,
  type WorkflowPusher,
} from "@corbits/seeding";
import {
  isSidecarUnavailableError,
  parseAs,
  type ApiCall,
} from "@corbits/hub-api-client";
import {
  persistConnectorCredential,
  type PersistConnectorCredentialFns,
} from "@corbits/connections/persist-credential";
import { CONNECTOR_REGISTRY } from "@corbits/connections/registry";
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
   * possible outcome (`@corbits/connections`' `OAuthStoreOutcome`,
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
  log: (line: string) => void;
};

export type TestAndPersistCredentialArgs = CommonArgs &
  PersistConnectorCredentialFns & {
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
  };

export type EnsureSeededArgs = CommonArgs & {
  tenant: PersonalTenant;
  provider: SupportedCredentialProvider;
  apiKey: string;
  baseURLOverride?: string;
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
};

export type CompleteCredentialArgs = CommonArgs &
  PersistConnectorCredentialFns & {
    userId: string;
    userEmail: string;
    provider: SupportedCredentialProvider;
    apiKey: string;
    credentialMetadata?: Record<string, unknown>;
    baseURLOverride?: string;
    seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
  };

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

/**
 * One provider's offerings out of a tenant's resolved catalog
 * (`GET /api/tenants/:id/models`), flattened to the shape
 * `resolveOllamaModelSource` picks a winner from.
 */
type CatalogOfferingCandidate = {
  readonly canonicalName: string;
  readonly plugin: string;
  readonly priority: number;
  readonly capabilities: readonly string[];
};

/**
 * Ollama's model resolution: what the instance ACTUALLY serves, never a
 * curated name it may not have pulled (CL-6366 — pinning
 * `CATALOG_SEEDS.ollama.models[0]` here killed every turn on any
 * instance without that exact model). By the time this runs,
 * `testAndPersistCredential` has already run `seedCatalog` against the
 * same tenant, which seeded this provider's catalog straight from its
 * live `/api/tags` — capability rows included (`fetchOllamaModelCatalog`,
 * CL-6366) — so the resolved catalog read below reflects exactly what
 * this instance offers, not the two-entry static seed.
 *
 * `preferCompletionCapable` narrows to completion-capable offerings
 * first — the same rule `selectDefaultInferencePreferences`
 * (`@corbits/chat`) and `defaultModelForProvider`
 * (`@workbench/inference-settings`) apply, so an embedding pull can
 * never win here either, by construction rather than by name-sorting
 * heuristic. The curated name (`CATALOG_SEEDS.ollama.models[0]`) is
 * honored only as a PREFERENCE among the surviving candidates — a tie
 * broken toward the name this repo already knows serves tool calls and
 * thinking — never as a value this can return when the instance doesn't
 * actually offer it.
 *
 * Discovery (`GET /models`) includes inherited operator catalog seeds, so
 * the curated name can "resolve" without living on this tenant's instance
 * (CL-7185). When that name appears in discovery, this also reads
 * tenant-owned `/catalog/models`. A non-empty owned list restricts
 * candidates to those names before the curated preference / priority sort;
 * an empty owned list keeps discovery (inherit-only). The extra fetch is
 * skipped when discovery does not contain the curated name.
 */
async function resolveOllamaModelSource(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  apiKey: string,
  baseURLOverride: string | undefined,
): Promise<ModelSource> {
  const catalogSeed = CATALOG_SEEDS.ollama;
  const baseURL = ollamaOpenAICompatBaseURL(
    baseURLOverride ?? catalogSeed.provider.baseURL,
  );

  const response = await api(
    "GET",
    `/api/tenants/${tenantId}/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    ModelInfo.array(),
    response.data,
    "resolved catalog response",
  );
  const candidates: CatalogOfferingCandidate[] = [];
  for (const model of models) {
    for (const offering of model.offerings) {
      if (offering.providerName !== catalogSeed.provider.name) continue;
      candidates.push({
        canonicalName: model.canonicalName,
        plugin: offering.plugin,
        priority: offering.priority,
        capabilities: offering.capabilities,
      });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `tenant ${tenantId} has no seeded ollama catalog offerings — seedCatalog must run before resolveOllamaModelSource`,
    );
  }

  const completionCapable = preferCompletionCapable(
    candidates,
    (candidate) => candidate.capabilities,
    (candidate) => candidate.canonicalName,
  );
  const curatedName = catalogSeed.models[0]?.canonicalName;
  let pool = completionCapable;
  if (
    curatedName !== undefined &&
    completionCapable.some(
      (candidate) => candidate.canonicalName === curatedName,
    )
  ) {
    const ownedResponse = await api(
      "GET",
      `/api/tenants/${tenantId}/catalog/models`,
      undefined,
      cookies,
    );
    const owned = parseAs(
      paginatedSchema(ModelResponse),
      ownedResponse.data,
      "tenant-owned catalog models response",
    ).data;
    if (owned.length > 0) {
      const ownedNames = new Set(owned.map((model) => model.canonicalName));
      pool = completionCapable.filter((candidate) =>
        ownedNames.has(candidate.canonicalName),
      );
    }
  }
  const preferred =
    curatedName !== undefined
      ? pool.find((candidate) => candidate.canonicalName === curatedName)
      : undefined;
  const winner =
    preferred ??
    [...pool].sort(
      (left, right) =>
        left.priority - right.priority ||
        left.canonicalName.localeCompare(right.canonicalName),
    )[0];
  if (winner === undefined) {
    throw new Error(
      `tenant ${tenantId}'s seeded ollama catalog resolved to no candidate model`,
    );
  }

  return {
    provider: winner.plugin,
    model: winner.canonicalName,
    baseURL,
    apiKey,
  };
}

/** The `ModelSource` `ensureSeeded` deploys every default workflow
 * against. Every provider but `ollama` has a fixed, always-available
 * curated model list (`CATALOG_SEEDS`), so its curated default is a safe
 * pin. `ollama` is the one provider whose actual model list is
 * per-instance and can diverge from that curated name entirely
 * (CL-6366) — its resolution defers to `resolveOllamaModelSource`, which
 * reads back what `seedCatalog` actually found on the instance rather
 * than repeating the static pin. `baseURLOverride` is the
 * configurable-base-URL seam every provider but `ollama` ignores (a
 * fixed origin); for `ollama` it is the root the person actually pointed
 * their instance at, normalized to the OpenAI-compatible `/v1` form this
 * deploys against. */
export async function modelSourceFor(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  provider: SupportedCredentialProvider,
  apiKey: string,
  baseURLOverride?: string,
): Promise<ModelSource> {
  if (provider === "ollama") {
    return resolveOllamaModelSource(
      api,
      cookies,
      tenantId,
      apiKey,
      baseURLOverride,
    );
  }

  const catalogSeed = CATALOG_SEEDS[provider];
  const defaultModel = catalogSeed.models[0];
  if (defaultModel === undefined) {
    throw new Error(
      `catalog seed for provider ${provider} has no default model`,
    );
  }
  return {
    provider: catalogSeed.provider.plugin,
    model: defaultModel.canonicalName,
    baseURL: catalogSeed.provider.baseURL,
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
  const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
  const tenant = await findPersonalTenant(args.api, args.cookies, expectedSlug);
  if (!tenant) return { kind: "no-personal-bench" };

  const descriptor = CONNECTOR_REGISTRY[args.provider];
  if (descriptor === undefined) {
    throw new Error(
      `no connector descriptor registered for provider ${args.provider}`,
    );
  }

  // The one shared persist-and-seed sequence (CL-6394): provider +
  // credential rows named the way the Plugins gallery's resolver reads
  // them back (`descriptor.id` / `descriptor.displayName`), then the
  // curated model catalog. An explicit user submission through a connect
  // UI — a pasted key or a completed OAuth exchange — always rotates a
  // name-conflicting credential (a regenerated key, or a retry after a
  // bad paste): see `ensureCredential`'s own `verified` doc comment in
  // `@corbits/seeding`'s `seed.ts` for the full rotation rule.
  await persistConnectorCredential({
    api: args.api,
    cookies: args.cookies,
    tenantId: tenant.tenantId,
    descriptor,
    secret: args.apiKey,
    log: args.log,
    ...(args.credentialMetadata !== undefined
      ? { credentialMetadata: args.credentialMetadata }
      : {}),
    ...(args.baseURLOverride !== undefined
      ? { baseURLOverride: args.baseURLOverride }
      : {}),
    ...(args.ensureProviderFn !== undefined
      ? { ensureProviderFn: args.ensureProviderFn }
      : {}),
    ...(args.ensureCredentialFn !== undefined
      ? { ensureCredentialFn: args.ensureCredentialFn }
      : {}),
    ...(args.seedCatalogFn !== undefined
      ? { seedCatalogFn: args.seedCatalogFn }
      : {}),
  });

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
    model: await modelSourceFor(
      args.api,
      args.cookies,
      args.tenant.tenantId,
      args.provider,
      args.apiKey,
      args.baseURLOverride,
    ),
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
    confirmDeployments: false,
  };
  try {
    await runSeedTenant(seedTenantArgs);
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
 * Both halves back to back, blocking until the bench is genuinely
 * deployed. For harnesses that need a fully provisioned bench before
 * they can begin — `@workbench/evals`' real-target is the only caller —
 * never for a route serving a person. Connect returns in seconds
 * precisely because it does NOT do this (CL-6457); see the module
 * comment above.
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
  const seeded = await ensureSeeded(
    args.seedTenantFn !== undefined
      ? { ...ensureSeededArgs, seedTenantFn: args.seedTenantFn }
      : ensureSeededArgs,
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
