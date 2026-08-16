// The guided credential step of first-run: a signed-in user who reached
// onboarding with no seed model configured picks a provider — any of
// `supportedCredentialProviders()` — and pastes their own key. The key is
// proven with a real, free call before anything is stored (see
// `@workbench/hub-client`'s `testProviderCredential`, which probes that
// provider's own auth-gated endpoint), and only once it's proven does
// this seed the caller's own personal bench — the same `seedCatalog` +
// `seedTenant` the first-login hook runs when a hub-owned key is
// configured, so a self-served key and an operator-configured one land
// the same bench. Both plant the credential through the hub's native
// `POST /api/tenants/:id/credentials` route (see `seedCatalog`'s
// `ensureCredential`) — this module never stores a secret itself.
//
// Two halves, on purpose. `testAndPersistCredential` — the fast half —
// proves the key and plants the credential and its catalog; it is the
// only half an OAuth callback route runs before redirecting, because
// nothing in it ever deploys a workflow. `ensureSeeded` — the slow half
// — is the workflow-deploy step that used to run inline in the same
// request: minutes of deploy calls a browser had no business waiting on
// mid-redirect. A pasted-key submission (`/complete`, a plain fetch, not
// a redirect the browser can double-fire) still runs both halves
// synchronously through `completeCredentialSetup` below, unchanged.
//
// `ensureSeeded` runs with `confirmDeployments: false`: the probe
// already proved the key is valid, so there is nothing left to confirm
// by triggering a real, billed inference call against the account the
// user just connected — only insufficient credit or a busy sidecar for
// a fully valid key to fail on, surfacing as a false "setup failed".
// Deployment itself still runs (it is configuration, not inference), so
// the bench's default workflows are genuinely usable once this returns.
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
  parseAs,
  seedCatalog,
  seedTenant,
  supportedCredentialProviders,
  testProviderCredential,
  type ApiCall,
  type ModelSource,
  type SeedCatalogArgs,
  type SeedTenantArgs,
  type SupportedCredentialProvider,
  type TestProviderCredentialArgs,
  type ToolRegistryPublisher,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { personalTenantSlug } from "./provision";

export type PersonalTenant = {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly principalId: string;
  readonly tenantDomain: string;
};

export type TestAndPersistCredentialResult =
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" }
  | ({ readonly kind: "connected" } & PersonalTenant);

export type EnsureSeededResult = {
  readonly kind: "seeded";
  readonly workflows: string[];
};

export type CompleteCredentialResult =
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" }
  | {
      readonly kind: "seeded";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly workflows: string[];
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
  testCredential?: (
    args: TestProviderCredentialArgs,
  ) => ReturnType<typeof testProviderCredential>;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
};

export type EnsureSeededArgs = CommonArgs & {
  tenant: PersonalTenant;
  provider: SupportedCredentialProvider;
  apiKey: string;
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
};

export type CompleteCredentialArgs = CommonArgs & {
  userId: string;
  userEmail: string;
  provider: SupportedCredentialProvider;
  apiKey: string;
  credentialMetadata?: Record<string, unknown>;
  testCredential?: (
    args: TestProviderCredentialArgs,
  ) => ReturnType<typeof testProviderCredential>;
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
 * (`CATALOG_SEEDS`), paired with the plaintext key that proved itself
 * against that same provider. */
export function modelSourceFor(
  provider: SupportedCredentialProvider,
  apiKey: string,
): ModelSource {
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
 * The fast half: proves an onboarding user's key with a real call
 * against the provider they picked, then plants it as a credential on
 * their own personal bench, alongside that provider's curated model
 * catalog. A bad key never reaches the tenant at all — the credential
 * test runs first and short-circuits everything else. Never deploys a
 * workflow — that is `ensureSeeded`'s job, deliberately kept out of this
 * half so an OAuth callback route can run only this and redirect
 * immediately.
 */
export async function testAndPersistCredential(
  args: TestAndPersistCredentialArgs,
): Promise<TestAndPersistCredentialResult> {
  const testCredential = args.testCredential ?? testProviderCredential;
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;

  const test = await testCredential({
    provider: args.provider,
    apiKey: args.apiKey,
  });
  if (!test.ok) return { kind: "invalid-credential", message: test.message };

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
  };
  await runSeedCatalog(
    args.credentialMetadata !== undefined
      ? { ...seedCatalogArgs, credentialMetadata: args.credentialMetadata }
      : seedCatalogArgs,
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
    model: modelSourceFor(args.provider, args.apiKey),
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
    confirmDeployments: false,
  };
  await runSeedTenant(
    args.publishToolRegistry !== undefined
      ? { ...seedTenantArgs, publishToolRegistry: args.publishToolRegistry }
      : seedTenantArgs,
  );

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

  const ensureSeededArgs = {
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    tenant: persisted,
    provider: args.provider,
    apiKey: args.apiKey,
  };
  const withPublishToolRegistry =
    args.publishToolRegistry !== undefined
      ? { ...ensureSeededArgs, publishToolRegistry: args.publishToolRegistry }
      : ensureSeededArgs;
  const seeded = await ensureSeeded(
    args.seedTenantFn !== undefined
      ? { ...withPublishToolRegistry, seedTenantFn: args.seedTenantFn }
      : withPublishToolRegistry,
  );

  return {
    kind: "seeded",
    tenantId: persisted.tenantId,
    tenantSlug: persisted.tenantSlug,
    workflows: seeded.workflows,
  };
}
