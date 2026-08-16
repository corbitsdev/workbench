// Seeds one already-known tenant with the default workflow set: plants
// the seed grants, then for each default workflow ensures its asset
// exists, pushes its current definition, deploys it, and confirms the
// deployment answers. Validation is part of seeding — a deployment that
// cannot be confirmed is a seed failure, and a run with nothing to seed
// is a failure too. Safe to re-run; every skipped step says so.
//
// Workflow package metadata (automatable, displayName) lives in each
// workflows/*/package.json under `corbits.workflow` and is mirrored in
// `@corbits/workflow-catalog`. Seed stamps displayName onto the asset so
// the routines picker can show a friendly label without reading package.json.

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
  buildAssistantWorkflow,
  serializeAssistantWorkflow,
} from "@corbits/assistant-workflow";
import {
  buildChannelDigestWorkflow,
  serializeChannelDigestWorkflow,
} from "@corbits/channel-digest-workflow";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "@corbits/echo-workflow";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "@corbits/heartbeat-workflow";
import {
  buildRecurringTaskWorkflow,
  serializeRecurringTaskWorkflow,
} from "@corbits/recurring-task-workflow";
import { WORKFLOW_CATALOG } from "@corbits/workflow-catalog";
import {
  publishCorbitsToolsRegistry,
  type PublishCorbitsToolsRegistryArgs,
} from "@corbits/tool-registry-publish";
import { CliError } from "./errors";
import { parseAs, type ApiCall } from "./hub";
import { CATALOG_SEEDS } from "./catalog-seed-data";
import type { SupportedCredentialProvider } from "./credential-test";

const GIT_TOKEN_TTL_MS = 10 * 60 * 1000;
const ECHO_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const ASSISTANT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Short: these two run on a tight, continuous schedule to exercise
// scheduling itself, so a wedged noop-inference call should surface
// fast rather than tie up a run slot for the full two minutes the
// conversational workflows above allow.
const HEARTBEAT_TURN_TIMEOUT_MS = 30 * 1000;
const CHANNEL_DIGEST_TURN_TIMEOUT_MS = 30 * 1000;
// Never actually runs (its routine fire is intercepted and dispatched
// as a task instead — see @corbits/recurring-task-workflow's own doc),
// so this timeout only bounds the deploy-time definition, never a real
// turn.
const RECURRING_TASK_TURN_TIMEOUT_MS = 30 * 1000;
const RUN_START_TIMEOUT_MS = 30_000;
const RUN_POLL_INTERVAL_MS = 1000;

// The deploy source the per-step agents launch against. The id is the
// routing key `defaultSource` must name; with exactly one source there
// is exactly one honest value for it.
const SEED_SOURCE_ID = "default";

// The provider/model pair `noop-inference` (packages/chat/src/noop-inference.ts)
// answers for any request, regardless of what is actually sent — the
// route ignores its body and `x-api-key` entirely. Naming a distinct
// pair here (rather than reusing the tenant's real model id) keeps a
// noop-pinned deployment visually distinct from a real one in the hub's
// UI and logs.
const NOOP_PROVIDER = "anthropic";
const NOOP_MODEL = "noop";

/**
 * A `ModelSource` pointed at the hub's own `noop-inference` endpoint
 * instead of a real provider — the same substitution
 * `packages/chat/src/platform-adapter.ts`'s `noopSourcesOverride` makes
 * for channel-host launches, reused here so a workflow deployed with
 * this source resolves every turn instantly against a constant,
 * locally served reply and never reaches a real model. `hubUrl` is the
 * same base URL `seedTenant` already receives, so no new configuration
 * is required to use it.
 */
export function NOOP_MODEL_SOURCE(hubUrl: string): ModelSource {
  return {
    provider: NOOP_PROVIDER,
    model: NOOP_MODEL,
    baseURL: `${hubUrl}/api/chat/noop-inference`,
    apiKey: "noop",
  };
}

const GitTokenMintResponse = type({ id: "string", secret: "string" });
const WorkflowDeploymentResponse = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
const WorkflowRunListResponse = type({ runIds: "string[]" });
// Post-deployment-dissolution wire shape: the trigger answers with the
// (self-anchored) run id, not a deployment id.
const WorkflowRunTriggerResponse = type({
  runId: "string",
  address: "string",
  messageId: "string",
});

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

/**
 * Whether a deployments-API row counts as live. The wire vocabulary is
 * "deployed" / "pending" / failure states (vendor hub-api
 * formatAllocationStatus) — there is no "active". This is the ONE
 * definition of "already deployed"; every seeded/skip check imports it.
 */
export function isLiveDeploymentStatus(status: string): boolean {
  return status === "deployed" || status === "pending";
}

export type PushOutcome = "pushed" | "unchanged";

export type WorkflowPusher = (args: {
  remoteUrl: string;
  tokenSecret: string;
  workflowJson: string;
}) => Promise<PushOutcome>;

export type DefaultWorkflow = {
  /** Asset name; lowercase-kebab so the smart-HTTP repo path is clean. */
  assetName: string;
  /** Friendly label stamped on the asset at create time. */
  displayName: string;
  /**
   * True when this workflow is a legitimate Routines-picker candidate
   * (schedulable automation). Conversational agents stay false.
   */
  automatable: boolean;
  buildJson: (tenantDomain: string, model: ModelSource) => string;
  /**
   * Overrides the deploy's inference source for this workflow only,
   * given the hub's own base URL. Present on the catalog-test workflow
   * `heartbeat`, which must stay free to run continuously: it names
   * `NOOP_MODEL_SOURCE` instead of the tenant's real catalog model.
   * Absent on every conversational workflow and on the seeded
   * channel-digest automation, which deploy against the tenant's real
   * model.
   */
  modelSource?: (hubUrl: string) => ModelSource;
};

function catalogDisplayName(assetName: string): string {
  return (
    WORKFLOW_CATALOG.find((entry) => entry.assetName === assetName)
      ?.displayName ?? assetName
  );
}

function catalogAutomatable(assetName: string): boolean {
  return (
    WORKFLOW_CATALOG.find((entry) => entry.assetName === assetName)
      ?.automatable ?? false
  );
}

/**
 * The workflow set every real tenant starts with: the echo
 * walking-skeleton, the general-purpose assistant, and the channel-digest
 * automation the Routines picker can honestly offer. This is what
 * `provisionPersonalTenantIfNeeded` (`@workbench/onboarding`) deploys
 * on first login for every real user — growing it is adding an entry
 * here, nothing more, but an entry here reaches every signup, so it is
 * never the place for a workflow that exists only to exercise the
 * platform itself. See `CATALOG_TEST_WORKFLOWS` for those.
 *
 * channel-digest is the seed automation: schedulable, not a chat host,
 * friendly display name. It uses the tenant's real model so a scheduled
 * run can produce a real digest line.
 */
export const DEFAULT_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "echo",
    displayName: catalogDisplayName("echo"),
    automatable: catalogAutomatable("echo"),
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
  {
    assetName: "assistant",
    displayName: catalogDisplayName("assistant"),
    automatable: catalogAutomatable("assistant"),
    buildJson: (tenantDomain, model) =>
      serializeAssistantWorkflow(
        buildAssistantWorkflow({
          triggerAddress: `assistant@${tenantDomain}`,
          inferencePreferences: [
            { provider: model.provider, model: model.model },
          ],
          turnTimeoutMs: ASSISTANT_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "channel-digest",
    displayName: catalogDisplayName("channel-digest"),
    automatable: catalogAutomatable("channel-digest"),
    buildJson: (tenantDomain, model) =>
      serializeChannelDigestWorkflow(
        buildChannelDigestWorkflow({
          triggerAddress: `channel-digest@${tenantDomain}`,
          inferencePreferences: [
            { provider: model.provider, model: model.model },
          ],
          turnTimeoutMs: CHANNEL_DIGEST_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "recurring-task",
    displayName: catalogDisplayName("recurring-task"),
    automatable: catalogAutomatable("recurring-task"),
    // Every real tenant needs a deployed "recurring-task" definition for
    // the Routines picker to offer — "Make this a routine" (an Inbox
    // action on a completed task result) prefills the create dialog
    // with this definition's id. Its own step is never actually run
    // (see @corbits/recurring-task-workflow's module doc), so the real
    // model here costs nothing extra to seed.
    buildJson: (tenantDomain, model) =>
      serializeRecurringTaskWorkflow(
        buildRecurringTaskWorkflow({
          triggerAddress: `recurring-task@${tenantDomain}`,
          inferencePreferences: [
            { provider: model.provider, model: model.model },
          ],
          turnTimeoutMs: RECURRING_TASK_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * Zero-cost workflows that exist to exercise the platform continuously
 * — `heartbeat` proves the scheduling and mail-trigger paths — never to
 * give a real user something to use. Pinned at `NOOP_MODEL_SOURCE` so
 * running them on a tight schedule costs nothing. Deliberately absent
 * from `DEFAULT_WORKFLOWS`: a real signup goes through
 * `provisionPersonalTenantIfNeeded`, which never seeds this set. Only an
 * explicit, dev/CI-specific caller (`workbench seed` with
 * `WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS` set) opts in.
 *
 * channel-digest used to live here as a platform exercise; it is now the
 * seed automation in `DEFAULT_WORKFLOWS` so every personal bench has an
 * honest Routines-picker option.
 */
export const CATALOG_TEST_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "heartbeat",
    displayName: catalogDisplayName("heartbeat"),
    automatable: catalogAutomatable("heartbeat"),
    buildJson: (tenantDomain, model) =>
      serializeHeartbeatWorkflow(
        buildHeartbeatWorkflow({
          triggerAddress: `heartbeat@${tenantDomain}`,
          inferencePreferences: [
            { provider: model.provider, model: model.model },
          ],
          turnTimeoutMs: HEARTBEAT_TURN_TIMEOUT_MS,
        }),
      ),
    modelSource: NOOP_MODEL_SOURCE,
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
  args: { tenantId: string; assetName: string; displayName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/assets`,
    {
      kind: "workflow",
      name: args.assetName,
      displayName: args.displayName,
    },
    cookies,
  );
  if (created.status === 201) {
    const asset = parseAs(AssetResponse, created.data, "asset response");
    log(`created workflow asset ${args.assetName} (${args.displayName})`);
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
    `/api/tenants/${args.tenantId}/assets?kind=workflow&inherited=false`,
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
      // Unique per run: a token's secret is only returned at mint, so a
      // re-run can never reuse the previous token — and an active token
      // with the same (user, name) makes the mint violate the hub's
      // uniqueness index. The short TTL reaps the leftovers.
      name: `workbench-seed-push-${crypto.randomUUID().slice(0, 8)}`,
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
    `/api/tenants/${args.tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentResponse.array(),
    listed.data,
    "deployments response",
  );
  const active = deployments.find(
    (d) =>
      d.definitionAssetId === args.assetId && isLiveDeploymentStatus(d.status),
  );
  if (active) {
    log(
      `workflow ${args.assetName} already deployed as ${active.id} (skipped)`,
    );
    return active.id;
  }

  const deployed = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/deployments`,
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

/**
 * Publishes the tenant's `corbits-tools` package-registry asset ahead
 * of any workflow deploy. Defaults to the real
 * `publishCorbitsToolsRegistry`; a test double can replace it so a
 * unit test never bundles a real tarball or dials the hub's tarball
 * REST routes, the same way `pushWorkflow` replaces the real git push.
 */
export type ToolRegistryPublisher = (
  args: Omit<PublishCorbitsToolsRegistryArgs, "fetchImpl">,
) => Promise<unknown>;

export type SeedTenantArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenant: SeedTenant;
  model: ModelSource;
  pushWorkflow: WorkflowPusher;
  publishToolRegistry?: ToolRegistryPublisher;
  log: (line: string) => void;
  workflows?: readonly DefaultWorkflow[];
  sleep?: (ms: number) => Promise<void>;
  runStartTimeoutMs?: number;
  runPollIntervalMs?: number;
  /**
   * Whether each deployment is confirmed by triggering a real mail
   * message and waiting for a run to start. Defaults to `true` — the
   * behavior `workbench seed` and the operator-key first-login hook
   * rely on, where a deployment nothing ever confirmed is treated as a
   * seed failure. A self-served connect flow (`@workbench/onboarding`'s
   * `completeCredentialSetup`) passes `false`: the key was already
   * proven with a free, auth-only probe before seeding started, so
   * spending the connecting user's own (possibly credit-less) balance
   * on a real inference call here would only re-litigate a question
   * already answered, at the user's expense.
   */
  confirmDeployments?: boolean;
};

/**
 * Plants the seed grants and deploys — and, unless told not to,
 * confirms — every default workflow for one already-known tenant. A
 * caller that already holds an authenticated session and a freshly
 * created tenant (the first-login provisioning hook, in particular)
 * seeds it without re-authenticating or re-resolving the tenant by
 * slug.
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
    confirmDeployments = true,
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

  // Deploying any workflow that pins a `@corbits/*` tool package (the
  // "assistant" default workflow pins `@corbits/memory-tools`) needs
  // the tenant's `corbits-tools` package-registry asset to already
  // carry that package's tarball, or the closure resolver fails the
  // launch with "unknown registry". Publishing ahead of the deploy
  // loop below — idempotent, and cheap relative to a workflow deploy —
  // means every seed run is a full seed, not one that skips whichever
  // workflow happens to pin an unresolved package.
  const publishToolRegistry =
    args.publishToolRegistry ?? publishCorbitsToolsRegistry;
  try {
    await publishToolRegistry({
      api,
      cookies,
      hubUrl,
      tenantId: tenant.tenantId,
      log,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(
      `publishing the corbits-tools package-registry asset failed: ${message}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
      { cause },
    );
  }

  let confirmed = 0;
  for (const workflow of workflows) {
    const workflowModel = workflow.modelSource?.(hubUrl) ?? model;
    const assetId = await ensureWorkflowAsset(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        assetName: workflow.assetName,
        displayName: workflow.displayName,
      },
      log,
    );

    const tokenSecret = await mintGitToken(api, cookies, tenant.tenantId);
    const outcome = await args.pushWorkflow({
      remoteUrl: `${hubUrl}/api/tenants/${tenant.tenantId}/assets/workflow/${workflow.assetName}.git`,
      tokenSecret,
      workflowJson: workflow.buildJson(tenant.domain, workflowModel),
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
        model: workflowModel,
      },
      log,
    );

    if (confirmDeployments) {
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
    }
    confirmed += 1;
  }

  if (confirmed !== workflows.length) {
    throw new CliError(
      `only ${confirmed} of ${workflows.length} default workflows were confirmed`,
      "check the failures reported above, fix them, then re-run: workbench seed",
    );
  }
  log(
    confirmDeployments
      ? `seed complete: ${confirmed} workflow(s) deployed and confirmed`
      : `seed complete: ${confirmed} workflow(s) deployed`,
  );
}

// The credential name a seeded inference source stores its secret
// under; distinct from the provider name so re-runs and manual
// inspection are never ambiguous about which is which. Exported so a
// caller that needs to find that same row later (e.g. checking whether
// a just-connected provider's credential already exists) names it the
// same way `seedCatalog` did, rather than re-deriving the convention.
export function inferenceCredentialName(providerName: string): string {
  return `${providerName}-default`;
}

export type EnsureProviderArgs = {
  tenantId: string;
  name: string;
  plugin: string;
  /** The API origin an `http`-plugin credential from this provider pins
   * its requests to (`CreateProvider`'s own field, `@intx/types`).
   * Every fixed connector today (GitHub, Exa, ...) lets the hub-side
   * plugin default this; a dynamic-origin connector — a tenant-supplied
   * MCP server URL — must set it explicitly, or credential resolution
   * fails closed with `no_origin`. */
  apiBaseUrl?: string;
};

export async function ensureProvider(
  api: ApiCall,
  cookies: string[],
  args: EnsureProviderArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/providers`,
    { name: args.name, plugin: args.plugin, apiBaseUrl: args.apiBaseUrl },
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

export type EnsureCredentialArgs = {
  tenantId: string;
  providerId: string;
  name: string;
  secret: string;
  type: "api_key" | "oauth_token";
  metadata?: Record<string, unknown>;
  /**
   * Set by a caller that received `secret` as an explicit user
   * submission through a connect UI (a pasted key, a completed OAuth
   * exchange) before reaching `ensureCredential` — never inferred here,
   * and never conditioned on a probe (CL-6123 dropped the onboarding
   * probe that used to gate this). Gates whether an `api_key` name
   * conflict rotates the stored secret (see the 409 branch below); an
   * `oauth_token` conflict decides rotation from the stored row's
   * `status` instead and ignores this flag. Left unset by a plain
   * `workbench seed` or the hub-owned env auto-plant (CL-6101's
   * `plantEnvProviderCredentials`, which keeps its own boot-time probe
   * but never sets this — its rule is never-overwrite, not rotate), so
   * a routine re-seed with an unchanged key still just skips.
   */
  verified?: boolean;
};

export async function ensureCredential(
  api: ApiCall,
  cookies: string[],
  args: EnsureCredentialArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/credentials`,
    {
      providerId: args.providerId,
      name: args.name,
      type: args.type,
      secret: args.secret,
      metadata: args.metadata,
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

  // An `oauth_token` credential (Hugging Face today) can reconnect under
  // its same stable name with a fresh secret and a fresh `expiresAt`
  // once the stored one has gone stale — reusing the stale row instead
  // of rotating it would silently strand the reconnect on the old,
  // already-expired secret, and since the row's `status` is already
  // non-`active`, the expiry sweep would never see it again to re-notify.
  // Scoped to exactly that case: an `active` row (the common idempotent
  // re-seed) is left untouched, so a routine re-seed with an unchanged
  // token never turns into a rotation.
  //
  // An `api_key` credential (OpenRouter, an onboarding-picked provider)
  // has no such staleness signal — its row stays `active` whether or not
  // the person reconnecting regenerated the key or is retrying after a
  // bad paste — so `status` can't gate it the way it gates `oauth_token`.
  // It rotates on a name conflict only when `args.verified` is set,
  // which a caller sets only for an explicit user submission through a
  // connect UI: `testAndPersistCredential`
  // (`@workbench/onboarding`'s `complete-credential.ts`) sets it
  // unconditionally for a pasted key or a completed OAuth exchange
  // (CL-6123 dropped the probe that used to gate this), and
  // `connections`' `POST /:connectorId/complete` (`routes.ts`) still
  // sets it only after `descriptor.probe` passes, since that surface
  // (Settings > Connections) is allowed to block on a real check. A
  // plain `workbench seed` never sets `verified` — its key comes
  // straight from env with no probe of its own — so that idempotent
  // re-seed still just skips, exactly as before.
  const shouldRotate =
    args.type === "oauth_token"
      ? existing.status !== "active"
      : args.verified === true;
  if (shouldRotate) {
    const rotated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/credentials/${existing.id}`,
      {
        secret: args.secret,
        status: "active",
        metadata: args.metadata,
      },
      cookies,
    );
    if (rotated.status !== 200) {
      throw new CliError(
        `the hub rejected rotating credential ${args.name} with status ${rotated.status}: ${JSON.stringify(rotated.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const credential = parseAs(
      CredentialResponse,
      rotated.data,
      "credential response",
    );
    log(
      `rotated credential ${args.name} (reconnect refreshed the stored secret)`,
    );
    return credential.id;
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

// Named so it can never be mistaken for a real secret if it leaks into
// a log line, a screenshot, or a bug report.
export const PLACEHOLDER_CATALOG_API_KEY = "placeholder-not-a-real-key";

export type SeedCatalogArgs = {
  api: ApiCall;
  cookies: string[];
  tenantId: string;
  log: (line: string) => void;
  /**
   * Which provider's curated catalog seed (`CATALOG_SEEDS`) to plant.
   * Defaults to `"anthropic"` — the operator-configured provider a plain
   * `workbench seed` plants — so every existing caller that seeds a
   * single hub-owned key keeps working unchanged. Onboarding's
   * self-served credential flow always passes the provider the person
   * actually connected.
   */
  provider?: SupportedCredentialProvider;
  /**
   * A real API key for `provider`. When set, `seedCatalog` plants a
   * credential row alongside the catalog data, making the seeded
   * offerings launchable.
   */
  apiKey?: string;
  /**
   * Explicit opt-in to plant a placeholder credential when `apiKey` is
   * not set, so a keyless dev or CI run can still launch channel
   * anchors. Plain `workbench seed` never sets this — only callers that
   * need a launchable chain without a real key (the local dev
   * bootstrap, the e2e harness) pass it.
   */
  placeholderCredential?: boolean;
  /**
   * The credential type the seeded row is stored as. Defaults to
   * `"api_key"` for a pasted secret; a connect flow that mints an
   * expiring OAuth access token (Hugging Face) passes `"oauth_token"`
   * so the row is honestly typed.
   */
  credentialType?: "api_key" | "oauth_token";
  /**
   * Overrides the seeded credential row's name — defaults to
   * `inferenceCredentialName(seed.provider.name)`. A caller whose
   * credential must also resolve by name elsewhere (the Plugins
   * gallery's `GET .../credentials/resolve/:name`, which looks up a
   * connector's `descriptor.displayName`) passes that same name here,
   * so the one row satisfies both readers instead of leaving a
   * connect flow's credential invisible to a reader that expects the
   * other naming convention.
   */
  credentialName?: string;
  /**
   * Free-form data attached to the seeded credential's `metadata`
   * field — the extension point a token's expiry timestamp lives in
   * (see `complete-credential.ts`), never interpreted by this function.
   */
  credentialMetadata?: Record<string, unknown>;
  /**
   * Passed straight through to `ensureCredential`'s own `verified` — set
   * only by a caller that already proved `apiKey` against the provider's
   * own probe before calling `seedCatalog` (onboarding's
   * `testAndPersistCredential`). A plain `workbench seed` never sets
   * this, since its key comes straight from env with no probe of its
   * own.
   */
  credentialVerified?: boolean;
};

/**
 * Plants one provider's curated catalog (see `catalog-seed-data.ts`) in a
 * tenant's catalog. The catalog model rows are always planted — data
 * only, viewable before any credential exists. The credential, catalog
 * provider, and offerings are planted only when a real `apiKey` is given
 * or `placeholderCredential` is explicitly set; without either, the
 * models are listable but nothing is launchable, and the caller is told
 * so. Idempotent: an already seeded chain is detected by name and
 * skipped, never duplicated.
 */
export async function seedCatalog(args: SeedCatalogArgs): Promise<void> {
  const { api, cookies, tenantId, log, provider = "anthropic" } = args;
  const seed = CATALOG_SEEDS[provider];

  const modelIds: string[] = [];
  for (const model of seed.models) {
    modelIds.push(
      await ensureCatalogModel(
        api,
        cookies,
        { tenantId, canonicalName: model.canonicalName },
        log,
      ),
    );
  }

  const credentialSecret =
    args.apiKey ??
    (args.placeholderCredential === true
      ? PLACEHOLDER_CATALOG_API_KEY
      : undefined);
  if (credentialSecret === undefined) {
    log(
      `catalog models for ${seed.provider.name} seeded without a credential; ` +
        `no channel or workflow can launch against them until a ${seed.provider.name} API key is set — set it in the hub's own environment and restart (the env-key auto-plant, CL-6101, then plants it with no other step), or set it here and re-run: workbench seed`,
    );
    return;
  }

  const providerId = await ensureProvider(
    api,
    cookies,
    { tenantId, name: seed.provider.name, plugin: seed.provider.plugin },
    log,
  );
  const baseCredentialArgs = {
    tenantId,
    providerId,
    name: args.credentialName ?? inferenceCredentialName(seed.provider.name),
    secret: credentialSecret,
    type: args.credentialType ?? ("api_key" as const),
    verified: args.credentialVerified ?? false,
  };
  const credentialId = await ensureCredential(
    api,
    cookies,
    args.credentialMetadata !== undefined
      ? { ...baseCredentialArgs, metadata: args.credentialMetadata }
      : baseCredentialArgs,
    log,
  );
  const catalogProviderId = await ensureCatalogProvider(
    api,
    cookies,
    {
      tenantId,
      name: seed.provider.name,
      plugin: seed.provider.plugin,
      baseURL: seed.provider.baseURL,
      credentialId,
    },
    log,
  );
  for (const modelId of modelIds) {
    await ensureCatalogOffering(
      api,
      cookies,
      { tenantId, modelId, providerId: catalogProviderId },
      log,
    );
  }

  log(
    `catalog ready: ${seed.provider.name}/${seed.models.map((m) => m.canonicalName).join(", ")}`,
  );
}
