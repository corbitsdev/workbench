// Seeds one already-known tenant with the default workflow set: plants
// the seed grants, then for each default workflow ensures its asset
// exists, pushes its current definition, deploys it, and confirms the
// deployment answers. Validation is part of seeding — a deployment that
// cannot be confirmed is a seed failure, and a run with nothing to seed
// is a failure too. Safe to re-run; every skipped step says so.

import {
  AssetResponse,
  AssetWithOriginResponse,
  CredentialResponse,
  GrantResponse,
  ModelOfferingResponse,
  ModelProviderResponse,
  ModelResponse,
  ProviderResponse,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "@corbits/echo-workflow";
import { CliError } from "./errors";
import { parseAs, type ApiCall } from "./hub";

const GIT_TOKEN_TTL_MS = 10 * 60 * 1000;
const ECHO_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const RUN_START_TIMEOUT_MS = 30_000;
const RUN_POLL_INTERVAL_MS = 1000;

// The deploy source the per-step agents launch against. The id is the
// routing key `defaultSource` must name; with exactly one source there
// is exactly one honest value for it.
const SEED_SOURCE_ID = "default";

const GitTokenMintResponse = type({ id: "string", secret: "string" });
const WorkflowDeploymentResponse = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
const WorkflowRunListResponse = type({ runIds: "string[]" });
const WorkflowRunTriggerResponse = type({
  deploymentId: "string",
  address: "string",
  messageId: "string",
});

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

export type PushOutcome = "pushed" | "unchanged";

export type WorkflowPusher = (args: {
  remoteUrl: string;
  tokenSecret: string;
  workflowJson: string;
}) => Promise<PushOutcome>;

export type DefaultWorkflow = {
  /** Asset name; lowercase-kebab so the smart-HTTP repo path is clean. */
  assetName: string;
  buildJson: (tenantDomain: string, model: ModelSource) => string;
};

/**
 * The workflow set a bench starts with. Today that is the echo
 * workflow; growing the set is adding an entry here, nothing more.
 */
export const DEFAULT_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "echo",
    buildJson: (tenantDomain, model) =>
      serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${tenantDomain}`,
          inferencePreferences: [
            { provider: model.provider, model: model.model },
          ],
          turnTimeoutMs: ECHO_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

// The grants the deploy, trigger, and run-listing routes gate on,
// planted at the wildcard scope the authz glob matcher resolves
// against any concrete deployment (the deployment id is minted at
// deploy time, so a concrete resource cannot be planted up front).
const SEED_GRANTS: readonly { resource: string; action: string }[] = [
  { resource: "workflow:*", action: "create" },
  { resource: "workflow:*", action: "read" },
  { resource: "workflow-run:*", action: "manage" },
  { resource: "workflow-run:*", action: "read" },
];

// The grants table has no unique constraint and the create route is a
// plain insert, so a re-run would accumulate duplicate rows; check for
// an equivalent grant first and report the skip.
async function plantGrant(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    principalId: string;
    resource: string;
    action: string;
  },
  log: (line: string) => void,
): Promise<void> {
  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/grants?principalId=${encodeURIComponent(args.principalId)}&resource=${encodeURIComponent(args.resource)}&limit=200`,
    undefined,
    cookies,
  );
  const grants = parseAs(
    paginatedSchema(GrantResponse),
    listed.data,
    "grants response",
  ).data;
  const existing = grants.find(
    (g) =>
      g.resource === args.resource &&
      g.action === args.action &&
      g.effect === "allow" &&
      g.principalId === args.principalId,
  );
  if (existing) {
    log(`grant ${args.resource}/${args.action} already exists (skipped)`);
    return;
  }
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/grants`,
    {
      principalId: args.principalId,
      resource: args.resource,
      action: args.action,
      effect: "allow",
      origin: "creator",
    },
    cookies,
  );
  if (created.status !== 201) {
    throw new CliError(
      `the hub rejected the ${args.resource}/${args.action} grant with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`granted ${args.resource}/${args.action}`);
}

async function ensureWorkflowAsset(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; assetName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/assets`,
    { kind: "workflow", name: args.assetName },
    cookies,
  );
  if (created.status === 201) {
    const asset = parseAs(AssetResponse, created.data, "asset response");
    log(`created workflow asset ${args.assetName}`);
    return asset.id;
  }
  if (created.status !== 409) {
    throw new CliError(
      `the hub rejected creation of workflow asset ${args.assetName} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/assets?kind=workflow`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    listed.data,
    "assets response",
  );
  const existing = assets.find((a) => a.name === args.assetName);
  if (!existing) {
    throw new CliError(
      `workflow asset ${args.assetName} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`workflow asset ${args.assetName} already exists (skipped)`);
  return existing.id;
}

async function mintGitToken(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string> {
  const minted = await api(
    "POST",
    `/api/tenants/${tenantId}/git-tokens`,
    {
      name: "workbench-seed-push",
      resource: "asset:*",
      refPattern: "**",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + GIT_TOKEN_TTL_MS).toISOString(),
    },
    cookies,
  );
  if (minted.status !== 201) {
    throw new CliError(
      `the hub refused to mint a git token for the workflow push (status ${minted.status}): ${JSON.stringify(minted.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  return parseAs(GitTokenMintResponse, minted.data, "git token response")
    .secret;
}

async function listRunIds(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; deploymentId: string },
): Promise<string[]> {
  const runs = await api(
    "GET",
    `/api/tenants/${args.tenantId}/workflows/${args.deploymentId}/runs`,
    undefined,
    cookies,
  );
  return parseAs(WorkflowRunListResponse, runs.data, "runs response").runIds;
}

async function ensureDeployment(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    assetId: string;
    assetName: string;
    model: ModelSource;
  },
  log: (line: string) => void,
): Promise<string> {
  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/workflows/instances`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentResponse.array(),
    listed.data,
    "deployments response",
  );
  const active = deployments.find(
    (d) => d.definitionAssetId === args.assetId && d.status === "active",
  );
  if (active) {
    log(
      `workflow ${args.assetName} already deployed as ${active.id} (skipped)`,
    );
    return active.id;
  }

  const deployed = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/instances`,
    {
      assetId: args.assetId,
      sources: [
        {
          id: SEED_SOURCE_ID,
          provider: args.model.provider,
          baseURL: args.model.baseURL,
          apiKey: args.model.apiKey,
          model: args.model.model,
        },
      ],
      defaultSource: SEED_SOURCE_ID,
    },
    cookies,
  );
  if (deployed.status === 502) {
    throw new CliError(
      `the hub could not deploy workflow ${args.assetName}: the sidecar is unavailable (${JSON.stringify(deployed.data)})`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (deployed.status !== 201) {
    throw new CliError(
      `the hub rejected deployment of workflow ${args.assetName} with status ${deployed.status}: ${JSON.stringify(deployed.data)}`,
      "re-run: workbench seed (it re-pushes the workflow definition); if this persists, check the hub logs for the hydration failure",
    );
  }
  const deployment = parseAs(
    WorkflowDeploymentResponse,
    deployed.data,
    "deployment response",
  );
  log(`deployed workflow ${args.assetName} as ${deployment.id}`);
  return deployment.id;
}

async function confirmDeploymentAnswers(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    deploymentId: string;
    assetName: string;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    intervalMs: number;
  },
  log: (line: string) => void,
): Promise<void> {
  const before = new Set(
    await listRunIds(api, cookies, {
      tenantId: args.tenantId,
      deploymentId: args.deploymentId,
    }),
  );

  const triggered = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/${args.deploymentId}/mail`,
    { content: "workbench seed validation: confirm this deployment answers" },
    cookies,
  );
  if (triggered.status === 409) {
    throw new CliError(
      `deployment ${args.deploymentId} of workflow ${args.assetName} is deployed but its address is not routable — the sidecar that hosts it is not connected`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (triggered.status !== 202) {
    throw new CliError(
      `the validation trigger for workflow ${args.assetName} was rejected with status ${triggered.status}: ${JSON.stringify(triggered.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  parseAs(WorkflowRunTriggerResponse, triggered.data, "trigger response");

  const attempts = Math.max(1, Math.ceil(args.timeoutMs / args.intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runIds = await listRunIds(api, cookies, {
      tenantId: args.tenantId,
      deploymentId: args.deploymentId,
    });
    const started = runIds.find((id) => !before.has(id));
    if (started !== undefined) {
      log(`confirmed workflow ${args.assetName}: run ${started} started`);
      return;
    }
    await args.sleep(args.intervalMs);
  }

  throw new CliError(
    `deployment ${args.deploymentId} of workflow ${args.assetName} accepted the validation trigger but no run started within ${Math.round(args.timeoutMs / 1000)}s`,
    "check the sidecar logs for the run failure, fix it, then re-run: workbench seed",
  );
}

/** The tenant identity `seedTenant` needs; resolved by the CLI's `runSeed`
 * from the bench slug, or already known to a caller (such as the
 * first-login provisioning hook) that just minted the tenant. */
export type SeedTenant = {
  tenantId: string;
  principalId: string;
  domain: string;
};

export type SeedTenantArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenant: SeedTenant;
  model: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  workflows?: readonly DefaultWorkflow[];
  sleep?: (ms: number) => Promise<void>;
  runStartTimeoutMs?: number;
  runPollIntervalMs?: number;
};

/**
 * Plants the seed grants and deploys and confirms every default
 * workflow for one already-known tenant. A caller that already holds
 * an authenticated session and a freshly created tenant (the
 * first-login provisioning hook, in particular) seeds it without
 * re-authenticating or re-resolving the tenant by slug.
 */
export async function seedTenant(args: SeedTenantArgs): Promise<void> {
  const {
    api,
    cookies,
    hubUrl,
    tenant,
    model,
    log,
    workflows = DEFAULT_WORKFLOWS,
  } = args;
  const sleep =
    args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = args.runStartTimeoutMs ?? RUN_START_TIMEOUT_MS;
  const intervalMs = args.runPollIntervalMs ?? RUN_POLL_INTERVAL_MS;

  if (workflows.length === 0) {
    throw new CliError(
      "the default workflow set is empty; seeding zero workflows is a failure, not a success",
      "restore the default workflow set in @workbench/hub-client before running: workbench seed",
    );
  }

  for (const grant of SEED_GRANTS) {
    await plantGrant(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        resource: grant.resource,
        action: grant.action,
      },
      log,
    );
  }

  let confirmed = 0;
  for (const workflow of workflows) {
    const assetId = await ensureWorkflowAsset(
      api,
      cookies,
      { tenantId: tenant.tenantId, assetName: workflow.assetName },
      log,
    );

    const tokenSecret = await mintGitToken(api, cookies, tenant.tenantId);
    const outcome = await args.pushWorkflow({
      remoteUrl: `${hubUrl}/api/tenants/${tenant.tenantId}/assets/workflow/${workflow.assetName}.git`,
      tokenSecret,
      workflowJson: workflow.buildJson(tenant.domain, model),
    });
    log(
      outcome === "pushed"
        ? `pushed workflow.json for ${workflow.assetName}`
        : `workflow.json for ${workflow.assetName} already current (skipped)`,
    );

    const deploymentId = await ensureDeployment(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        assetId,
        assetName: workflow.assetName,
        model,
      },
      log,
    );

    await confirmDeploymentAnswers(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        deploymentId,
        assetName: workflow.assetName,
        sleep,
        timeoutMs,
        intervalMs,
      },
      log,
    );
    confirmed += 1;
  }

  if (confirmed !== workflows.length) {
    throw new CliError(
      `only ${confirmed} of ${workflows.length} default workflows were confirmed`,
      "check the failures reported above, fix them, then re-run: workbench seed",
    );
  }
  log(`seed complete: ${confirmed} workflow(s) deployed and confirmed`);
}

// The credential name a seeded inference source stores its secret
// under; distinct from the provider name so re-runs and manual
// inspection are never ambiguous about which is which.
function inferenceCredentialName(providerName: string): string {
  return `${providerName}-default`;
}

async function ensureProvider(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; name: string; plugin: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/providers`,
    { name: args.name, plugin: args.plugin },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(
      ProviderResponse,
      created.data,
      "provider response",
    );
    log(`created provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new CliError(
      `the hub rejected creation of provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ProviderResponse),
    listed.data,
    "providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new CliError(
      `provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`provider ${args.name} already exists (skipped)`);
  return existing.id;
}

async function ensureCredential(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; providerId: string; name: string; secret: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/credentials`,
    {
      providerId: args.providerId,
      name: args.name,
      type: "api_key",
      secret: args.secret,
    },
    cookies,
  );
  if (created.status === 201) {
    const credential = parseAs(
      CredentialResponse,
      created.data,
      "credential response",
    );
    log(`created credential ${args.name}`);
    return credential.id;
  }
  if (created.status !== 409) {
    throw new CliError(
      `the hub rejected creation of credential ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/credentials`,
    undefined,
    cookies,
  );
  const credentials = parseAs(
    paginatedSchema(CredentialResponse),
    listed.data,
    "credentials response",
  ).data;
  const existing = credentials.find((c) => c.name === args.name);
  if (!existing) {
    throw new CliError(
      `credential ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(
    `credential ${args.name} already exists (skipped; its secret is not updated by seeding)`,
  );
  return existing.id;
}

async function ensureCatalogModel(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; canonicalName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/models`,
    { canonicalName: args.canonicalName },
    cookies,
  );
  if (created.status === 201) {
    const model = parseAs(
      ModelResponse,
      created.data,
      "catalog model response",
    );
    log(`created catalog model ${args.canonicalName}`);
    return model.id;
  }
  if (created.status !== 409) {
    throw new CliError(
      `the hub rejected creation of catalog model ${args.canonicalName} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    paginatedSchema(ModelResponse),
    listed.data,
    "catalog models response",
  ).data;
  const existing = models.find((m) => m.canonicalName === args.canonicalName);
  if (!existing) {
    throw new CliError(
      `catalog model ${args.canonicalName} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog model ${args.canonicalName} already exists (skipped)`);
  return existing.id;
}

async function ensureCatalogProvider(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    name: string;
    plugin: string;
    baseURL: string;
    credentialId: string;
  },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    {
      name: args.name,
      plugin: args.plugin,
      baseURL: args.baseURL,
      credentialId: args.credentialId,
    },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(
      ModelProviderResponse,
      created.data,
      "catalog provider response",
    );
    log(`created catalog provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new CliError(
      `the hub rejected creation of catalog provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ModelProviderResponse),
    listed.data,
    "catalog providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new CliError(
      `catalog provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog provider ${args.name} already exists (skipped)`);
  return existing.id;
}

async function ensureCatalogOffering(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; modelId: string; providerId: string },
  log: (line: string) => void,
): Promise<void> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/offerings`,
    { modelId: args.modelId, providerId: args.providerId },
    cookies,
  );
  if (created.status === 201) {
    parseAs(ModelOfferingResponse, created.data, "catalog offering response");
    log("created catalog offering");
    return;
  }
  if (created.status === 409) {
    log("catalog offering already exists (skipped)");
    return;
  }
  throw new CliError(
    `the hub rejected creation of the catalog offering with status ${created.status}: ${JSON.stringify(created.data)}`,
    "check the hub logs for the underlying failure, then re-run: workbench seed",
  );
}

export type SeedInferenceSourceArgs = {
  api: ApiCall;
  cookies: string[];
  tenantId: string;
  source: ModelSource;
  log: (line: string) => void;
};

/**
 * Plants the full launchable chain for one inference source in a
 * tenant's catalog — provider, credential, catalog model, catalog
 * provider, and offering — so interactive instances and deployed
 * workflows have a model to resolve against. Idempotent: an already
 * seeded chain is detected by name and skipped, never duplicated.
 */
export async function seedInferenceSource(
  args: SeedInferenceSourceArgs,
): Promise<void> {
  const { api, cookies, tenantId, source, log } = args;

  const providerId = await ensureProvider(
    api,
    cookies,
    { tenantId, name: source.provider, plugin: source.provider },
    log,
  );
  const credentialId = await ensureCredential(
    api,
    cookies,
    {
      tenantId,
      providerId,
      name: inferenceCredentialName(source.provider),
      secret: source.apiKey,
    },
    log,
  );
  const modelId = await ensureCatalogModel(
    api,
    cookies,
    { tenantId, canonicalName: source.model },
    log,
  );
  const catalogProviderId = await ensureCatalogProvider(
    api,
    cookies,
    {
      tenantId,
      name: source.provider,
      plugin: source.provider,
      baseURL: source.baseURL,
      credentialId,
    },
    log,
  );
  await ensureCatalogOffering(
    api,
    cookies,
    { tenantId, modelId, providerId: catalogProviderId },
    log,
  );

  log(`inference source ready: ${source.provider}/${source.model}`);
}
