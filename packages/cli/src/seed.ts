// `workbench seed`: authenticate as the administrator, resolve the
// configured bench by slug, and seed it with the default workflow set
// through `@workbench/hub-client`'s `seedTenant`. Safe to re-run; every
// skipped step says so.

import { paginatedSchema, PrincipalSummary, TenantResponse } from "@intx/types";
import {
  authenticate,
  parseAs,
  seedCatalog,
  seedTenant,
  CATALOG_TEST_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  type ApiCall,
  type DefaultWorkflow,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { CliError } from "@workbench/hub-client";
import type { SeedConfig } from "./config";

export type SeedDeps = {
  config: SeedConfig;
  api: ApiCall;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  runStartTimeoutMs?: number;
  runPollIntervalMs?: number;
  /**
   * Plant a placeholder catalog credential when ANTHROPIC_API_KEY is
   * not set, so the tenant catalog is launchable without a real key.
   * Plain `workbench seed` never sets this; the local dev bootstrap and
   * the e2e harness do, since they need a launchable channel anchor
   * without a real key.
   */
  placeholderCredential?: boolean;
};

async function resolveTenant(
  api: ApiCall,
  cookies: string[],
  slug: string,
): Promise<{ tenantId: string; principalId: string; domain: string }> {
  const principals = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    principals.data,
    "principals response",
  );
  const membership = summary.data.find((p) => p.tenantSlug === slug);
  if (!membership) {
    throw new CliError(
      `bench ${slug} does not exist on the hub (or this account is not a member of it)`,
      "provision it first: workbench setup — then re-run: workbench seed",
    );
  }
  const tenant = await api(
    "GET",
    `/api/tenants/${membership.tenantId}`,
    undefined,
    cookies,
  );
  if (tenant.status !== 200) {
    throw new CliError(
      `the hub refused to describe bench ${slug} (status ${tenant.status}): ${JSON.stringify(tenant.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  const row = parseAs(TenantResponse, tenant.data, "tenant response");
  return {
    tenantId: membership.tenantId,
    principalId: membership.principalId,
    domain: row.domain,
  };
}

/**
 * The workflow set a plain `workbench seed` deploys: the real default
 * set every tenant gets, plus the zero-cost catalog-test workflows
 * only when the caller has explicitly opted in via
 * `WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS`. A real bench never sets
 * that variable, so it only ever gets `DEFAULT_WORKFLOWS` — the same
 * set `provisionPersonalTenantIfNeeded` deploys on first login.
 */
export function resolveSeedWorkflows(
  config: Pick<SeedConfig, "seedCatalogTestWorkflows">,
): readonly DefaultWorkflow[] {
  return config.seedCatalogTestWorkflows
    ? [...DEFAULT_WORKFLOWS, ...CATALOG_TEST_WORKFLOWS]
    : DEFAULT_WORKFLOWS;
}

export async function runSeed(
  deps: SeedDeps,
  workflows?: readonly DefaultWorkflow[],
): Promise<void> {
  const { config, api, log } = deps;
  if (config.adminDefaulted) {
    log(
      "using default admin alice@example.com — set HUB_ADMIN_EMAIL and HUB_ADMIN_PASSWORD for real deployments",
    );
  }
  const resolvedWorkflows = workflows ?? resolveSeedWorkflows(config);
  if (config.seedCatalogTestWorkflows) {
    log(
      "WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS=1: also deploying the zero-cost catalog-test workflows (heartbeat, channel-digest)",
    );
  }

  const session = await authenticate(api, {
    email: config.adminEmail,
    password: config.adminPassword,
  });
  const cookies = session.cookies;
  const tenant = await resolveTenant(api, cookies, config.orgSlug);
  log(`seeding bench ${config.orgSlug} (${tenant.tenantId})`);

  const seedArgs: Parameters<typeof seedTenant>[0] = {
    api,
    cookies,
    hubUrl: config.hubUrl,
    tenant,
    model: config.modelSource,
    pushWorkflow: deps.pushWorkflow,
    log,
    workflows: resolvedWorkflows,
  };
  if (deps.sleep !== undefined) seedArgs.sleep = deps.sleep;
  if (deps.runStartTimeoutMs !== undefined)
    seedArgs.runStartTimeoutMs = deps.runStartTimeoutMs;
  if (deps.runPollIntervalMs !== undefined)
    seedArgs.runPollIntervalMs = deps.runPollIntervalMs;

  await seedTenant(seedArgs);

  if (
    !config.anthropicApiKeyConfigured &&
    deps.placeholderCredential !== true
  ) {
    log(
      "ANTHROPIC_API_KEY is not set; the tenant catalog is seeded with data only — no credential is planted, so channels and workflows cannot launch until you set it and re-run: workbench seed",
    );
  }
  await seedCatalog({
    api,
    cookies,
    tenantId: tenant.tenantId,
    log,
    ...(config.anthropicApiKeyConfigured
      ? { apiKey: config.modelSource.apiKey }
      : {}),
    ...(deps.placeholderCredential === true
      ? { placeholderCredential: true }
      : {}),
  });
}
