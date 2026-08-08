// The guided credential step of first-run: a signed-in user who reached
// onboarding with no seed model configured picks a provider — Anthropic,
// OpenAI, or Google — and pastes their own key. The key is proven with
// a real call before anything is stored (see `@workbench/hub-client`'s
// `testProviderCredential`, which itself goes through `@intx/inference`'s
// own adapter for that provider), and only once it's proven does this
// seed the caller's own personal bench — the same `seedCatalog` +
// `seedTenant` the first-login hook runs when a hub-owned key is
// configured, so a self-served key and an operator-configured one land
// the same bench. Both plant the credential through the hub's native
// `POST /api/tenants/:id/credentials` route (see `seedCatalog`'s
// `ensureCredential`) — this module never stores a secret itself.

import { PrincipalSummary, TenantResponse, paginatedSchema } from "@intx/types";
import {
  DEFAULT_WORKFLOWS,
  parseAs,
  providerModelSource,
  seedCatalog,
  seedTenant,
  testProviderCredential,
  type ApiCall,
  type SeedCatalogArgs,
  type SeedTenantArgs,
  type SupportedCredentialProvider,
  type TestProviderCredentialArgs,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { personalTenantSlug } from "./provision";

export type CompleteCredentialResult =
  | { readonly kind: "invalid-credential"; readonly message: string }
  | { readonly kind: "no-personal-bench" }
  | {
      readonly kind: "seeded";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly workflows: string[];
    };

export type CompleteCredentialArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  userId: string;
  userEmail: string;
  provider: SupportedCredentialProvider;
  apiKey: string;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  testCredential?: (
    args: TestProviderCredentialArgs,
  ) => ReturnType<typeof testProviderCredential>;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
};

async function findPersonalTenant(
  api: ApiCall,
  cookies: string[],
  expectedSlug: string,
): Promise<
  { tenantId: string; tenantSlug: string; principalId: string } | undefined
> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  return summary.data
    .map((p) => ({
      tenantId: p.tenantId,
      tenantSlug: p.tenantSlug,
      principalId: p.principalId,
    }))
    .find((p) => p.tenantSlug === expectedSlug);
}

/**
 * Proves an onboarding user's key with a real call against the provider
 * they picked, then seeds their own personal bench with it. A bad key
 * never reaches the tenant at all — the credential test runs first and
 * short-circuits everything else. The tenant's model catalog (the
 * browsable list a channel picks a model from) is only planted for
 * Anthropic today; the other providers still get their credential
 * stored and their default routines deployed and confirmed, since
 * `DEFAULT_WORKFLOWS` picks its inference source per source, not from
 * the catalog.
 */
export async function completeCredentialSetup(
  args: CompleteCredentialArgs,
): Promise<CompleteCredentialResult> {
  const testCredential = args.testCredential ?? testProviderCredential;
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;
  const runSeedTenant = args.seedTenantFn ?? seedTenant;

  const test = await testCredential({
    provider: args.provider,
    apiKey: args.apiKey,
  });
  if (!test.ok) return { kind: "invalid-credential", message: test.message };

  const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
  const own = await findPersonalTenant(args.api, args.cookies, expectedSlug);
  if (!own) return { kind: "no-personal-bench" };

  const tenantResponse = await args.api(
    "GET",
    `/api/tenants/${own.tenantId}`,
    undefined,
    args.cookies,
  );
  const tenant = parseAs(
    TenantResponse,
    tenantResponse.data,
    "tenant response",
  );

  if (args.provider === "anthropic") {
    await runSeedCatalog({
      api: args.api,
      cookies: args.cookies,
      tenantId: own.tenantId,
      apiKey: args.apiKey,
      log: args.log,
    });
  } else {
    args.log(
      `bench ${own.tenantSlug}: skipping the browsable model catalog for provider ${args.provider}; only Anthropic is catalogued today`,
    );
  }

  const modelSource = providerModelSource(args.provider);
  await runSeedTenant({
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    tenant: {
      tenantId: own.tenantId,
      principalId: own.principalId,
      domain: tenant.domain,
    },
    model: {
      provider: modelSource.provider,
      model: modelSource.model,
      baseURL: modelSource.baseURL,
      apiKey: args.apiKey,
    },
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
  });

  return {
    kind: "seeded",
    tenantId: own.tenantId,
    tenantSlug: own.tenantSlug,
    workflows: DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName),
  };
}
