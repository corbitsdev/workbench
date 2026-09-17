// Setup-flow tenant seeding, owned by `@workbench/onboarding` (CL-7585):
// The default-workflow set (`DEFAULT_WORKFLOWS`, `CATALOG_WORKFLOWS`),
// the seed grants, skill planting, and
// `seedTenant`, the grants-plus-workflows installer the first-login
// provisioning hook drives. The catalog half (`seedCatalog`,
// `ensureCredential`, `ensureProvider`, `ensureNoopCatalogOffering`,
// `CATALOG_SEEDS`) lives at `@corbits/connections/seed-catalog`, and
// the git-push transport (`WorkflowPusher`, `createGitWorkflowPusher`)
// at `@corbits/connections/workflow-push`.
//
// Dropped in the move, on purpose: `CATALOG_TEST_WORKFLOWS` (the
// heartbeat platform-exercise entry) and `EXCLUDED_WORKFLOW_SOURCES`
// were consumed only by the deleted package's own tests — no product
// or suite code outside it referenced either — and
// `NOOP_MODEL_SOURCE` went with the heartbeat entry as its only user.
// The `WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS` opt-in nothing read dies
// with them.
//
// Seeds one already-known tenant with the default workflow set: plants
// the seed grants, then for each default workflow ensures its asset
// exists, pushes its current definition, deploys it, and confirms the
// deployment answers. Validation is part of seeding — a deployment that
// cannot be confirmed is a seed failure, and a run with nothing to seed
// is a failure too. Safe to re-run; every skipped step says so.
//
// Workflow package metadata (automatable, displayName) lives in each
// workflows/*/package.json under `corbits.workflow` and is mirrored in
// `@workbench/templates`. Seed stamps displayName onto the asset so
// the scheduled-workflow picker can show a friendly label without reading package.json.

import {
  AssetResponse,
  AssetWithOriginResponse,
  GrantResponse,
  ModelInfo,
  WorkflowRunHealth,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import { deriveRunPrincipalId } from "@intx/hub-common";
import type { InferencePreference } from "@intx/agent";
import {
  buildAssistantWorkflow,
  serializeAssistantWorkflow,
} from "@corbits/assistant-workflow";
import {
  buildCodeReviewWorkflow,
  serializeCodeReviewWorkflow,
} from "@corbits/code-review-workflow";
import {
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "@corbits/workbench-digest-workflow";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "@corbits/echo-workflow";
import {
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "@corbits/last-30-days-research-workflow";
import {
  buildGranolaCallWorkflow,
  serializeGranolaCallWorkflow,
} from "@corbits/granola-call-workflow";
import {
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "@corbits/morning-brief-workflow";
import {
  buildExaTopicWatchWorkflow,
  serializeExaTopicWatchWorkflow,
} from "@corbits/exa-topic-watch-workflow";
import {
  buildProcessGranolaCallWorkflow,
  serializeProcessGranolaCallWorkflow,
} from "@corbits/process-granola-call-workflow";
import {
  buildAttioTaskAgentWorkflow,
  serializeAttioTaskAgentWorkflow,
} from "@corbits/attio-task-agent-workflow";
import {
  buildPainPointCollateralWorkflow,
  serializePainPointCollateralWorkflow,
} from "@corbits/pain-point-collateral-workflow";
import {
  buildRedditOpportunityScannerWorkflow,
  serializeRedditOpportunityScannerWorkflow,
} from "@corbits/reddit-opportunity-scanner-workflow";
import {
  buildCollateralGenerationWorkflow,
  serializeCollateralGenerationWorkflow,
} from "@corbits/collateral-generation-workflow";
import {
  buildDiligenceBriefWorkflow,
  serializeDiligenceBriefWorkflow,
} from "@corbits/diligence-brief-workflow";
import { WORKFLOW_CATALOG } from "@corbits/workflows/catalog";
import { WORKFLOW_SOURCE_ENTRY } from "@corbits/workflows";
import {
  HubApiError,
  SidecarUnavailableError,
  parseAs,
  type ApiCall,
} from "@corbits/hub-api-client";
import { DEFAULT_SKILLS } from "@corbits/connections/default-skills";
import { ensureNoopCatalogOffering } from "@corbits/connections/seed-catalog";
import type { WorkflowPusher } from "@corbits/connections/workflow-push";

const GIT_TOKEN_TTL_MS = 10 * 60 * 1000;
const ECHO_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const ASSISTANT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const WORKBENCH_DIGEST_TURN_TIMEOUT_MS = 30 * 1000;
// A research turn fans out across multiple source tools and writes a
// long-form report, so it gets the same generous allowance as the
// other conversational workflows above, not the short catalog-test
// budget.
const LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Matches the conversational default every folded builder in this
// codebase uses: a review turn reads a diff and posts one review, the
// same order of work as a research or assistant turn.
const CODE_REVIEW_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Same conversational default as the entries above: one mail-triggered
// reasoning turn per run, no multi-step DAG.
const GRANOLA_CALL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const MORNING_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const EXA_TOPIC_WATCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// A transcript-plus-extraction-plus-verification pass over a long call
// can run well past the shortest steps in the catalog (see the
// workflow's own README), so this gets extra headroom.
const PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ATTIO_TASK_AGENT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const COLLATERAL_GENERATION_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const DILIGENCE_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const RUN_START_TIMEOUT_MS = 30_000;
const RUN_POLL_INTERVAL_MS = 1000;

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

/**
 * A provider/model pair a deployed workflow's rendered definition names
 * in its inference preferences (`DefaultWorkflow.buildJson`'s second
 * argument). What a deployment actually resolves inference against is
 * the tenant's catalog offerings, resolved separately by `ensureDeployment`
 * (or, for a noop-pinned workflow, `ensureNoopCatalogOffering`) — this
 * type carries no `baseURL`/`apiKey` because `seedTenant` never needs
 * either (CL-7461).
 */
export type ModelSource = {
  readonly provider: string;
  readonly model: string;
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
  /**
   * Renders the definition's JSON given the tenant's mail domain and the
   * ordered provider/model preferences to deploy against. Takes the bare
   * preference list — never a full `ModelSource` — so this same
   * function serves both `seedTenant`'s HTTP-deploy path (whose actual
   * deploy source is a set of catalog offering ids, resolved separately
   * by `ensureDeployment`) and a native in-process deploy path
   * (`apps/hub/src/templates/block-workflows.ts`) that only ever has the
   * tenant's real, possibly multi-entry inference preferences on hand.
   */
  buildJson: (
    tenantDomain: string,
    inferencePreferences: readonly InferencePreference[],
  ) => string;
  /**
   * Overrides the deploy's inference source for this workflow only.
   * Present on a workflow that must stay free to run continuously: it
   * names a synthetic model source instead of the tenant's real catalog
   * model, and `seedTenant` deploys it against a dedicated noop catalog
   * offering (`ensureNoopCatalogOffering`) rather than the tenant's own
   * resolved offerings. Absent on every conversational workflow and on
   * the seeded workbench-digest automation, which deploy against the
   * tenant's real model.
   */
  modelSource?: () => ModelSource;
  /**
   * When true, PUT the authored definition to `stopped` after deploy so
   * a native ScheduleTrigger does not fire every tenant at the next
   * matching minute. Absent means leave the schema default (`deployed`).
   */
  startStopped?: true;
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
 * The asset name of the agent a person actually talks to on a brand-new
 * bench — Myra, the setup agent. Named here because deploy ORDER depends
 * on it (see `DEFAULT_WORKFLOWS`) and because every surface that asks
 * "can this person start yet?" answers by looking for this one asset,
 * never by counting the whole set.
 */
export const SETUP_AGENT_ASSET_NAME = "assistant";

/**
 * The workflow set every real tenant starts with: the general-purpose
 * assistant, and nothing else (CL-7074). This is what
 * `provisionPersonalTenantIfNeeded` (`@workbench/onboarding`) deploys
 * on first login for every real user — growing it is adding an entry
 * here, nothing more, but an entry here reaches every signup, so it is
 * never the place for a workflow that is not something every person
 * needs the moment they land. `echo`, `workbench-digest`, and
 * `last-30-days-research` used to live here; a signup paid a git push
 * and a sidecar probe for each of them even though nobody asked for
 * them. They now live in `CATALOG_WORKFLOWS`, deployable through the
 * catalog instantiate route (CL-7073) rather than seeded onto every
 * bench.
 *
 * Order is a product decision, not a formality (CL-6462): `seedTenant`
 * deploys this array in sequence at roughly 20s each, and the setup
 * agent is the only entry a person needs before they can start talking.
 * It goes first so a fresh signup lands in a working conversation in
 * seconds while the rest converge behind them; a signup that waited on
 * the whole set stared at a progress screen for minutes.
 */
export const DEFAULT_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: SETUP_AGENT_ASSET_NAME,
    displayName: catalogDisplayName(SETUP_AGENT_ASSET_NAME),
    automatable: catalogAutomatable(SETUP_AGENT_ASSET_NAME),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeAssistantWorkflow(
        buildAssistantWorkflow({
          triggerAddress: `${SETUP_AGENT_ASSET_NAME}@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ASSISTANT_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * Workflows every real tenant CAN have, but none is deployed by default
 * (CL-7074) — a caller deploys one on demand the same way `seedTenant`
 * deploys any `DefaultWorkflow`: `ensureWorkflowAsset` →
 * `pushWorkflow` → `ensureDeployment`. `CL-7073` is the caller that
 * offers these from a catalog/instantiate surface; nothing here reaches
 * a bench until something asks for it by name. An asset already
 * deployed on an existing bench (a prior seed run, before these moved
 * out of `DEFAULT_WORKFLOWS`) is untouched — there is no orphan-retire
 * for these entries, on purpose (see `docs/seed-reconciliation.md`).
 */
export const CATALOG_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "echo",
    displayName: catalogDisplayName("echo"),
    automatable: catalogAutomatable("echo"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ECHO_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "workbench-digest",
    displayName: catalogDisplayName("workbench-digest"),
    automatable: catalogAutomatable("workbench-digest"),
    buildJson: (_tenantDomain, inferencePreferences) =>
      serializeWorkbenchDigestWorkflow(
        buildWorkbenchDigestWorkflow({
          inferencePreferences,
          turnTimeoutMs: WORKBENCH_DIGEST_TURN_TIMEOUT_MS,
        }),
      ),
    startStopped: true,
  },
  {
    assetName: "last-30-days-research",
    displayName: catalogDisplayName("last-30-days-research"),
    automatable: catalogAutomatable("last-30-days-research"),
    // Deployed automation, on demand. Seed never POSTs a wrapper row;
    // last-30-days-research stays a deployed workflow without a native
    // ScheduleTrigger.
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeLast30DaysResearchWorkflow(
        buildLast30DaysResearchWorkflow({
          triggerAddress: `last-30-days-research@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "code-review",
    displayName: catalogDisplayName("code-review"),
    automatable: catalogAutomatable("code-review"),
    // Deployed automation, on demand, same as every other entry here
    // (CL-7073): the instantiate route used to build this one definition
    // through its own hardcoded copy in
    // `apps/hub/src/templates/block-workflows.ts`; that copy is gone and
    // this entry is now the one source of truth for it, same as every
    // other catalog workflow.
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCodeReviewWorkflow(
        buildCodeReviewWorkflow({
          triggerAddress: `code-review@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: CODE_REVIEW_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "granola-call",
    displayName: catalogDisplayName("granola-call"),
    automatable: catalogAutomatable("granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeGranolaCallWorkflow(
        buildGranolaCallWorkflow({
          triggerAddress: `granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "morning-brief",
    displayName: catalogDisplayName("morning-brief"),
    automatable: catalogAutomatable("morning-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeMorningBriefWorkflow(
        buildMorningBriefWorkflow({
          triggerAddress: `morning-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: MORNING_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "exa-topic-watch",
    displayName: catalogDisplayName("exa-topic-watch"),
    automatable: catalogAutomatable("exa-topic-watch"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeExaTopicWatchWorkflow(
        buildExaTopicWatchWorkflow({
          triggerAddress: `exa-topic-watch@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: EXA_TOPIC_WATCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "process-granola-call",
    displayName: catalogDisplayName("process-granola-call"),
    automatable: catalogAutomatable("process-granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeProcessGranolaCallWorkflow(
        buildProcessGranolaCallWorkflow({
          triggerAddress: `process-granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "attio-task-agent",
    displayName: catalogDisplayName("attio-task-agent"),
    automatable: catalogAutomatable("attio-task-agent"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeAttioTaskAgentWorkflow(
        buildAttioTaskAgentWorkflow({
          triggerAddress: `attio-task-agent@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ATTIO_TASK_AGENT_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "pain-point-collateral",
    displayName: catalogDisplayName("pain-point-collateral"),
    automatable: catalogAutomatable("pain-point-collateral"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializePainPointCollateralWorkflow(
        buildPainPointCollateralWorkflow({
          triggerAddress: `pain-point-collateral@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "reddit-opportunity-scanner",
    displayName: catalogDisplayName("reddit-opportunity-scanner"),
    automatable: catalogAutomatable("reddit-opportunity-scanner"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeRedditOpportunityScannerWorkflow(
        buildRedditOpportunityScannerWorkflow({
          triggerAddress: `reddit-opportunity-scanner@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "collateral-generation",
    displayName: catalogDisplayName("collateral-generation"),
    automatable: catalogAutomatable("collateral-generation"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCollateralGenerationWorkflow(
        buildCollateralGenerationWorkflow({
          triggerAddress: `collateral-generation@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: COLLATERAL_GENERATION_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "diligence-brief",
    displayName: catalogDisplayName("diligence-brief"),
    automatable: catalogAutomatable("diligence-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeDiligenceBriefWorkflow(
        buildDiligenceBriefWorkflow({
          triggerAddress: `diligence-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: DILIGENCE_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * The asset names of `CATALOG_WORKFLOWS`, strings only (CL-7585): callers
 * that name the catalog set without building anything from it (the hub's
 * scheduled-routes catalog, the Routines Available list) import this
 * rather than `CATALOG_WORKFLOWS` itself, so no per-workflow `buildJson`
 * closure crosses into their code.
 */
export const CATALOG_WORKFLOW_ASSET_NAMES: readonly string[] =
  CATALOG_WORKFLOWS.map((workflow) => workflow.assetName);

/**
 * The deployable-through-the-catalog-instantiate-route entry for one
 * asset name (CL-7073), or `undefined` if none exists. `CATALOG_WORKFLOWS`
 * is the one source of truth for "has a source package under
 * `workflows/<name>` and can be deployed on demand" — `DEFAULT_WORKFLOWS`
 * (seeded already, never re-deployed through this path) answers
 * `undefined` here on purpose.
 */
export function deployableCatalogWorkflow(
  assetName: string,
): DefaultWorkflow | undefined {
  return CATALOG_WORKFLOWS.find((workflow) => workflow.assetName === assetName);
}

// The grants the deploy, trigger, and run-listing routes gate on,
// planted at the wildcard scope the authz glob matcher resolves
// against any concrete deployment (the deployment id is minted at
// deploy time, so a concrete resource cannot be planted up front).
export const SEED_GRANTS: readonly { resource: string; action: string }[] = [
  { resource: "workflow:*", action: "create" },
  { resource: "workflow:*", action: "read" },
  { resource: "workflow-run:*", action: "manage" },
  { resource: "workflow-run:*", action: "read" },
  // Workflow-definition read/update (stop a startStopped deploy, list
  // definitions) and extra workflow-run verbs none of the grants above
  // cover. Those routes gate on their own resource/action pairs.
  { resource: "workflow-definition:*", action: "read" },
  { resource: "workflow-definition:*", action: "update" },
  { resource: "workflow-run:*", action: "create" },
  { resource: "workflow-run:*", action: "write" },
  // CL-6346 moved the room routes (post a message, read-state, typing,
  // reactions, pins, the live stream) off `workflow-run:<id>` and onto
  // `room:<id>`. The two grants above used to be what carried a
  // non-owner principal through those routes; without the room pair
  // beside them the rename leaves every seeded principal that is not a
  // wildcard owner unable to read or write its own workbenches.
  { resource: "room:*", action: "read" },
  { resource: "room:*", action: "write" },
  // CL-6465: the eval-run read routes (`GET .../eval-runs/runs`,
  // `GET .../eval-runs/runs/:runId`) gate on this resource.
  { resource: "eval-run:*", action: "read" },
  // Agent-authored workflows (`@corbits/workflows`'s `./authoring`
  // `author`/`republish` routes): a seeded principal was never granted
  // "create"/"write" on "asset:*" before, because no workflow-run write
  // surface checked it — every prior workflow-run write route (skills,
  // capabilities, agent-directory) either wrote as the "hub" RepoStore
  // principal with no grant-store check, or was scoped narrowly enough
  // to skip one (see those packages' own CL-6085-referencing doc
  // comments). Authoring a workflow asset is deploying executable code,
  // not a markdown skill, so this is the one write surface that adds a
  // real per-write grant check rather than following that precedent.
  // These are the SAME resource/verb the human-session asset routes
  // already gate on (`requireGrant("asset:*", "create")` and the
  // tarball routes' `requireGrant(idResource("asset", "assetId"),
  // "write")`) — extended to workflow-run principals, not a new grant
  // vocabulary.
  { resource: "asset:*", action: "create" },
  { resource: "asset:*", action: "write" },
  // Firm memory (CL-8186): `@corbits/memory`'s mounted routes gate on
  // `requireGrant("memory", action)` (see its `routes/deps.ts`
  // `grantGuard`) — "add" for `POST .../memory/add`, "search" for both
  // `POST .../memory/search` and `GET .../memory/list` (list reuses the
  // search grant; there is no separate "list" action). Grants never
  // inherit across tenants, so every workflow-run principal needs its
  // own pair, exactly like every other tenant-scoped resource above.
  { resource: "memory", action: "add" },
  { resource: "memory", action: "search" },
];

// Grants planted ONLY on Myra's own run principal (see
// `plantAssistantRunPrincipalGrants`), not the tenant's shared principal
// `SEED_GRANTS` above reconciles — these let Myra mint/revoke grants
// for her own specialist agents without handing
// every seeded principal in the tenant that same reach.
//
// `@corbits/access-tools`' workflow-run-authenticated routes
// (`list_principals`, `list_grants`, `grant_access`, `revoke_access`):
// read on both, plus create/manage on grants so Myra can mint and revoke
// the scoped grants she stands up for her own specialist agents.
// `principal:*`/`grant:*` on the shared principal would let it read and
// mint grants for every principal in the tenant, not just its own
// specialist agents.
//
// CL-7588: catalog administration is UI-only — writes go through the
// tenant-admin catalog routes (`vendor/intx/hub-api/src/routes/
// {models,model-providers,model-offerings}.ts`) behind a browser session,
// never through a workflow child. Myra's run principal keeps the catalog
// reads her `list_model_concepts`/`pick_models`/`estimate_run_cost` tools
// resolve through, and nothing more: a tenant-wide grant would let every
// seeded principal administer the catalog, not just Myra.
const ASSISTANT_RUN_PRINCIPAL_GRANTS: readonly {
  resource: string;
  action: string;
}[] = [
  { resource: "principal:*", action: "read" },
  { resource: "grant:*", action: "read" },
  { resource: "grant:*", action: "create" },
  { resource: "grant:*", action: "manage" },
  { resource: "model:*", action: "read" },
  { resource: "model-provider:*", action: "read" },
  { resource: "model-offering:*", action: "read" },
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
    throw new HubApiError(
      `the hub rejected the ${args.resource}/${args.action} grant with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`granted ${args.resource}/${args.action}`);
}

/**
 * Reconciles one tenant's grants to exactly `SEED_GRANTS`: every declared
 * grant present, nothing beyond it. This is the one path that plants
 * `SEED_GRANTS` — `seedTenant`'s full seed and `provisionPersonalTenantIfNeeded`'s
 * already-seeded short-circuit both call this instead of each owning
 * their own pass, so a grant added to `SEED_GRANTS` after a tenant was
 * first seeded reaches that tenant the next time either path runs, not
 * only on a brand-new signup. `plantGrant` is itself idempotent (it
 * checks for an equivalent grant before creating one), so reconciling
 * twice never duplicates a row.
 */
export async function reconcileSeedGrants(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  principalId: string,
  log: (line: string) => void,
): Promise<void> {
  for (const grant of SEED_GRANTS) {
    await plantGrant(
      api,
      cookies,
      { tenantId, principalId, resource: grant.resource, action: grant.action },
      log,
    );
  }
}

/**
 * Plants `ASSISTANT_RUN_PRINCIPAL_GRANTS` (the `@corbits/access-tools`
 * and `@corbits/catalog-tools` grants) on Myra's OWN run principal, not
 * the tenant's shared principal (CL-7467, CL-7468). `deriveRunPrincipalId`
 * is the same deterministic `(tenantId, runId)` derivation
 * `@intx/hub-api`'s `workflow-run-trigger` uses to mint a deployment's
 * run principal on its first materialized trigger — since a deployment's
 * top-level run id never changes across a relaunch, this stays stable
 * for the life of the deployment, unlike a fresh per-invocation run id.
 * Only called once `confirmDeploymentAnswers` has actually triggered the
 * assistant deployment (`confirmDeployments: true`), because that
 * trigger is what commits the run-principal row this grant references;
 * the connect flow's `confirmDeployments: false` path defers this until
 * the tenant's next `workbench seed` run finds a confirmed deployment.
 */
async function plantAssistantRunPrincipalGrants(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; deploymentId: string },
  log: (line: string) => void,
): Promise<void> {
  const runPrincipalId = await deriveRunPrincipalId(
    args.tenantId,
    args.deploymentId,
  );
  for (const grant of ASSISTANT_RUN_PRINCIPAL_GRANTS) {
    await plantGrant(
      api,
      cookies,
      {
        tenantId: args.tenantId,
        principalId: runPrincipalId,
        resource: grant.resource,
        action: grant.action,
      },
      log,
    );
  }
}

async function plantDefaultSkills(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  log: (line: string) => void,
): Promise<void> {
  for (const skill of DEFAULT_SKILLS) {
    const existing = await api(
      "GET",
      `/api/tenants/${tenantId}/skills/${encodeURIComponent(skill.name)}`,
      undefined,
      cookies,
    );
    if (existing.status === 200) {
      log(`skill ${skill.name} already exists (skipped)`);
      continue;
    }
    const created = await api(
      "POST",
      `/api/tenants/${tenantId}/skills`,
      {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        scope: "tenant",
      },
      cookies,
    );
    if (created.status === 409) {
      // The by-name GET above missed a row that the create route still
      // considers a conflict (an inherited/other-scope row, or a race
      // with a concurrent seed pass) — "already exists" is a skip, not
      // a fatal error, exactly like every other seed step's 409.
      log(`skill ${skill.name} already exists (skipped)`);
      continue;
    }
    if (created.status === 404) {
      // Stock Interchange cutover (hub fd3a43e2): the skills mount is
      // gone, so the plant endpoint 404s with the rest. Bounded and
      // loud — log through the pipeline (swallowing is acceptable here;
      // the reconcile re-read below reports these pins "blocked" on its
      // own) and stop trying further default skills. Every other status
      // keeps its old meaning.
      log(
        `[seed] default skill "${skill.name}" unavailable: POST /api/tenants/${tenantId}/skills returned 404 (skills surface removed by the stock cutover); skipping remaining default skills`,
      );
      return;
    }
    if (created.status !== 201) {
      throw new HubApiError(
        `the hub rejected the default skill "${skill.name}" with status ${created.status}: ${JSON.stringify(created.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    log(`seeded skill ${skill.name}`);
  }
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
    throw new HubApiError(
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
    throw new HubApiError(
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
    throw new HubApiError(
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

/**
 * Whether a "deployed" deployment's run is actually routable right now.
 * `GET .../runs/:runId/health` reads `sidecarRouter.getRoutableAddresses()`
 * — the hub's in-memory table binding an agent address to the specific
 * connected sidecar socket that owns it — so this is a live check, not a
 * read of the persisted `workflow_run.status` column the caller already
 * has. That column survives a hub/sidecar restart; the routing table
 * does not, so a "deployed" row can answer `false` here forever until
 * something redeploys it. 404 (run never existed) and 410 (run stopped)
 * both count as not routable: either way, nothing this deployment id
 * names can be reused.
 */
async function isDeploymentRoutable(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  deploymentId: string,
): Promise<boolean> {
  const health = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/runs/${deploymentId}/health`,
    undefined,
    cookies,
  );
  if (health.status === 404 || health.status === 410) return false;
  if (health.status !== 200) {
    throw new HubApiError(
      `the hub answered deployment ${deploymentId}'s health check with status ${health.status}: ${JSON.stringify(health.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  return (
    parseAs(WorkflowRunHealth, health.data, "run health response").liveness ===
    "ok"
  );
}

async function ensureDeployment(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    assetId: string;
    assetName: string;
    commitSha: string;
    sourceOfferingIds: readonly string[];
    defaultSourceOfferingId: string;
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
    if (await isDeploymentRoutable(api, cookies, args.tenantId, active.id)) {
      log(
        `workflow ${args.assetName} already deployed as ${active.id} (skipped)`,
      );
      return active.id;
    }
    // The DB row survives a stack restart; the in-memory sidecar
    // routing table that binds an address to a live process does not.
    // Restart the hub and sidecar and every previously "deployed"
    // workflow_run still reads "deployed" while nothing routes its
    // address. Skipping here would just move the same 409
    // `confirmDeploymentAnswers` hits below one step earlier — redeploy
    // fresh instead of trusting a status column that outlived the
    // process it described.
    log(
      `workflow ${args.assetName}'s deployment ${active.id} is stale (its sidecar is gone); redeploying`,
    );
  }

  const deployed = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/deployments`,
    {
      source: {
        kind: "asset",
        assetId: args.assetId,
        package: { format: "source", commitSha: args.commitSha },
      },
      entry: WORKFLOW_SOURCE_ENTRY,
      sourceOfferingIds: args.sourceOfferingIds,
      defaultSourceOfferingId: args.defaultSourceOfferingId,
    },
    cookies,
  );
  if (deployed.status === 502) {
    throw new SidecarUnavailableError(
      `the hub could not deploy workflow ${args.assetName}: the sidecar is unavailable (${JSON.stringify(deployed.data)})`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (deployed.status !== 201) {
    throw new HubApiError(
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

const DiscoveredModelsResponse = ModelInfo.array();

/**
 * Lists the offering ids visible to a tenant by flattening the platform's
 * own model discovery (`GET .../models`): every model resolved for the
 * tenant after inheritance, shadowing, and disable suppression, with each
 * model's offerings in resolution order. Seeding a tenant whose catalog is
 * inherited rather than directly owned (e.g. a sub-tenant under a
 * parent that already carries a real provider key) needs this resolved
 * view, not the tenant-owned-only `GET .../catalog/offerings`.
 */
async function listDiscoveredModelOfferings(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<{ id: string; priority: number }[]> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    DiscoveredModelsResponse,
    listed.data,
    "discovered models response",
  );
  return models.flatMap((model) =>
    model.offerings.map((offering) => ({
      id: offering.offeringId,
      priority: offering.priority,
    })),
  );
}

/**
 * Resolves the catalog offering ids a REAL (non-noop-pinned) workflow
 * deploys against: every offering visible to the tenant (owned or
 * inherited from an ancestor), ordered by priority ascending, with the
 * lowest-priority offering as the default —
 * the SAME rule `apps/hub/src/index.ts`'s `workflowDeployer.deploy` and
 * `packages/chat/src/platform-adapter.ts`'s `catalogOfferings` apply
 * in-process via `listVisibleOfferings`. `excludeOfferingId` drops the
 * noop offering (`ensureNoopCatalogOffering`) from this list when one
 * has already been planted on the same tenant this run — it must never
 * win a real workflow's default just because it happens to sort first.
 *
 * Throws when nothing is left to deploy against: "seeded but not
 * launchable" (`seedCatalog` with no credential) is a valid catalog
 * state, but a workflow deploy that names zero sources is not a
 * lesser success, it is the failure this function exists to catch
 * before the hub's own `sourceOfferingIds` validation would.
 */
async function resolveRealSourceOfferingIds(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  excludeOfferingId: string | undefined,
): Promise<{
  sourceOfferingIds: readonly string[];
  defaultSourceOfferingId: string;
}> {
  const offerings = (await listDiscoveredModelOfferings(api, cookies, tenantId))
    .filter((offering) => offering.id !== excludeOfferingId)
    .sort((a, b) => a.priority - b.priority);
  const defaultSourceOfferingId = offerings[0]?.id;
  if (defaultSourceOfferingId === undefined) {
    throw new HubApiError(
      "this tenant has no catalog offerings to deploy against — nothing is launchable yet",
      "seed the tenant's catalog with a real provider key (or a placeholder credential for a keyless dev/CI run), then re-run: workbench seed",
    );
  }
  return {
    sourceOfferingIds: offerings.map((offering) => offering.id),
    defaultSourceOfferingId,
  };
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
    throw new HubApiError(
      `deployment ${args.deploymentId} of workflow ${args.assetName} is deployed but its address is not routable — the sidecar that hosts it is not connected`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (triggered.status !== 202) {
    throw new HubApiError(
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

  throw new HubApiError(
    `deployment ${args.deploymentId} of workflow ${args.assetName} accepted the validation trigger but no run started within ${Math.round(args.timeoutMs / 1000)}s`,
    "check the sidecar logs for the run failure, fix it, then re-run: workbench seed",
  );
}

/** The tenant identity `seedTenant` needs; already known to a caller
 * (such as the first-login provisioning hook) that just minted the
 * tenant. */
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
  /**
   * The provider/model pair a real (non-noop-pinned) workflow's rendered
   * definition names in its inference preferences. The deploy itself
   * resolves inference from the tenant's own catalog offerings
   * (`resolveRealSourceOfferingIds`), not from this pair — a tenant with
   * no catalog offerings still fails clearly at deploy time even if this
   * pair happens to name a real model.
   */
  model: ModelSource;
  pushWorkflow: WorkflowPusher;
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
 *
 * Grants + workflows, then prune of leftover preset routine wrappers.
 * Assumes the tenant hierarchy already exposes `corbits-tools`
 * (published at `workbench setup` onto the root); seed does not pack
 * tarballs or run freshness.
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
    throw new HubApiError(
      "the default workflow set is empty; seeding zero workflows is a failure, not a success",
      "restore the default workflow set (packages/onboarding/src/tenant-seed.ts) before running: workbench seed",
    );
  }

  await reconcileSeedGrants(
    api,
    cookies,
    tenant.tenantId,
    tenant.principalId,
    log,
  );

  await plantDefaultSkills(api, cookies, tenant.tenantId, log);

  // Resolved lazily and cached across the loop below: most seed runs
  // deploy several workflows against the same tenant catalog state, so
  // this fetches the tenant's real offerings (or plants the noop one)
  // at most once each, however many workflows ask for them.
  let noopOfferingId: string | undefined;
  let realOfferings:
    | { sourceOfferingIds: readonly string[]; defaultSourceOfferingId: string }
    | undefined;

  let confirmed = 0;
  for (const workflow of workflows) {
    const workflowModel = workflow.modelSource?.() ?? model;

    let sourceOfferingIds: readonly string[];
    let defaultSourceOfferingId: string;
    if (workflow.modelSource !== undefined) {
      noopOfferingId ??= await ensureNoopCatalogOffering(
        api,
        cookies,
        tenant.tenantId,
        hubUrl,
        log,
      );
      sourceOfferingIds = [noopOfferingId];
      defaultSourceOfferingId = noopOfferingId;
    } else {
      realOfferings ??= await resolveRealSourceOfferingIds(
        api,
        cookies,
        tenant.tenantId,
        noopOfferingId,
      );
      ({ sourceOfferingIds, defaultSourceOfferingId } = realOfferings);
    }

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
    const pushed = await args.pushWorkflow({
      remoteUrl: `${hubUrl}/api/tenants/${tenant.tenantId}/assets/workflow/${workflow.assetName}.git`,
      tokenSecret,
      workflowJson: workflow.buildJson(tenant.domain, [
        { provider: workflowModel.provider, model: workflowModel.model },
      ]),
      packageName: `@workbench-seed/${workflow.assetName}`,
    });
    log(
      pushed.outcome === "pushed"
        ? `pushed the workflow source package for ${workflow.assetName}`
        : `workflow source for ${workflow.assetName} already current (skipped)`,
    );

    const deploymentId = await ensureDeployment(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        assetId,
        assetName: workflow.assetName,
        commitSha: pushed.commitSha,
        sourceOfferingIds,
        defaultSourceOfferingId,
      },
      log,
    );

    if (workflow.startStopped === true) {
      // Stock Interchange cutover: the old
      // `PUT .../agent-definitions/:id/status` stop surface is gone and
      // stock `@intx/hub-api` exposes no deployment-stop route, so a
      // `startStopped` seed can no longer stop its definition after
      // deploy. The flag is honored best-effort: schedule suppression
      // now lives in the workflow source itself. Logged, not thrown —
      // a seed must not fail because a stop surface no longer exists.
      log(
        `startStopped requested for ${workflow.assetName} but stock composition exposes no stop route; leaving it deployed`,
      );
    }
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
      if (workflow.assetName === SETUP_AGENT_ASSET_NAME) {
        await plantAssistantRunPrincipalGrants(
          api,
          cookies,
          { tenantId: tenant.tenantId, deploymentId },
          log,
        );
      }
    }
    confirmed += 1;
  }

  if (confirmed !== workflows.length) {
    throw new HubApiError(
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
