// `workbench seed`: authenticate as the administrator, resolve the
// configured bench by slug, and seed it with the default workflow set
// through `@workbench/hub-client`'s `seedTenant`. Safe to re-run; every
// skipped step says so.

import { paginatedSchema, PrincipalSummary, TenantResponse } from "@intx/types";
import {
  authenticate,
  parseAs,
  seedInferenceSource,
  seedTenant,
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

export async function runSeed(
  deps: SeedDeps,
  workflows: readonly DefaultWorkflow[] = DEFAULT_WORKFLOWS,
): Promise<void> {
  const { config, api, log } = deps;

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
    workflows,
  };
  if (deps.sleep !== undefined) seedArgs.sleep = deps.sleep;
  if (deps.runStartTimeoutMs !== undefined)
    seedArgs.runStartTimeoutMs = deps.runStartTimeoutMs;
  if (deps.runPollIntervalMs !== undefined)
    seedArgs.runPollIntervalMs = deps.runPollIntervalMs;

  await seedTenant(seedArgs);

  if (!config.inferenceApiKeyConfigured) {
    log(
      "SEED_INFERENCE_API_KEY is not set; seeding the tenant catalog with a placeholder credential — inference will error until you set SEED_INFERENCE_API_KEY and re-run: workbench seed",
    );
  }
  await seedInferenceSource({
    api,
    cookies,
    tenantId: tenant.tenantId,
    source: config.inferenceSource,
    log,
  });
}
