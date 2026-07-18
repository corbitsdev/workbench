import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkflowDeployOrchestrator,
  deriveDeploymentAddress,
  deriveStepAddress,
  deriveStepAgentId,
  walkCapabilities,
  type CapabilityWalkResult,
  type DeployWorkflowResult,
  type DeploySingleStepFn,
  type LaunchSessionFn,
  type SendMultiStepDeployFn,
  type WorkflowRepoWriter,
} from "@intx/workflow-deploy";
import type { DirectorRegistry } from "@intx/agent";
import { schema as intxSchema } from "@intx/db";
import { and, eq } from "drizzle-orm";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import type { GrantRule } from "@intx/authz";
import {
  toolPackagesForCapabilities,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_KIND_TAG,
} from "@workbench/agents";
import { getConfig } from "../config";
import type { HubDb } from "../db";
import type { WorkflowDefinition } from "@intx/workflow";
import type { AgentDefinition, BaseEnv } from "@intx/agent";

type WorkflowPrimitive = WorkflowDefinition["steps"][string];
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type { AgentDeployWorkflow } from "@intx/types/sidecar";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import {
  workflowDefinitionEnvelopeSchema,
  type AgentRepoStore,
  type DeployContent,
  type SidecarRouter,
} from "@intx/hub-sessions";
import {
  assembleWorkflowDeployConfig,
  collectDeclaredStepModels,
  collectDeclaredStepModelMaxTokens,
  resolveWorkflowDeployConfig,
  resolveWorkflowDeploySource,
} from "./workflow-deploy-config";

const log = getLogger(["services", "workflow-deploy"]);

// The `workflow`-kind repo stores the deployed definition as `workflow.json` at
// `refs/heads/main`, keyed by `workflow.id` (== the deployment's `kind`). The
// orchestrator's WorkflowRepoWriter writes it; the sidecar's spawn-child reads
// the same file. A re-drive reads it back to reconstruct the deploy frame.
const WORKFLOW_JSON_PATH = "workflow.json";

// The workflow-kind handler enforces the definition tree on this ref; the
// sidecar's spawn-child reads workflow.json from it.
const WORKFLOW_DEPLOY_REF = "refs/heads/main";

// Per-step grants ride at `state/grants.json` on the agent-state repo's
// state-bearing ref. Both sides read this exact (ref, path): interchange's
// supervisor (`STEP_GRANTS_REF`/`STEP_GRANTS_PATH` in
// `workflow-host/src/supervisor/credentials.ts`) and our sidecar's
// `readStepGrants` (`workflow-substrate-factory.ts`). The agent-state kind
// handler allows the `state/` top-level on any non-deploy ref.
const STEP_GRANTS_REF = "refs/heads/main";
const STEP_GRANTS_PATH = "state/grants.json";

// The resource-string prefix + action the step-agent reactor evaluates each
// tool call against (`evaluateGrants("tool:<name>", "invoke", ...)`), mirroring
// the DB-row grammar in `apps/hub/src/lib/tool-grants.ts`.
const TOOL_GRANT_RESOURCE_PREFIX = "tool:";

export type DeployWorkflowParams = {
  workflow: WorkflowDefinition;
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  creatorPrincipalId: string;
  config: HarnessConfig;
  deployContent: DeployContent;
  toolPackagePins?: readonly ToolPackagePin[];
  hubPublicKey?: string;
};

export type EnsureDeploymentRoutableArgs = {
  deploymentId: string;
  // The workflow definition id (== workflowRun.kind == workflow repo id) the
  // persisted definition is read back under.
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
  deploymentDomain: string;
};

export type EnsureDeploymentRoutableResult = {
  // true when this call re-established the supervisor; false when it was already
  // routable (no-op).
  reestablished: boolean;
};

export type ProvisionRunDeploymentArgs = {
  // The workflow definition id (== workflowRun.kind == workflow repo id) the
  // persisted definition is read back under.
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
  deploymentDomain: string;
  hubPublicKey: string;
};

export interface WorkflowDeployService {
  deployWorkflow(params: DeployWorkflowParams): Promise<DeployWorkflowResult>;
  // Persist a workflow's catalog entry WITHOUT deploying a supervisor: write the
  // git-backed `workflow` definition repo and the per-step DB/grant rows exactly
  // as `deployWorkflow` does, but send NO `agent.deploy` frame to the sidecar and
  // spawn no supervisor. This is the operator/boot publish path — a definition
  // registers at rest with zero live instances; the supervisor is minted per run
  // by `provisionRunDeployment`. Because it never touches the sidecar, publishing
  // succeeds with the sidecar disconnected.
  persistCatalog(params: DeployWorkflowParams): Promise<DeployWorkflowResult>;
  // Provision a fresh, single-use deployment for ONE workflow run (per-run
  // deployment, CL-2582). Reads the kind's published definition from its
  // `workflow`-kind repo (the definition registry), resolves a fresh
  // deploymentId + HarnessConfig, and deploys the supervisor + steps. Unlike the
  // operator deploy route this writes NO `workflow_run` registry row — the
  // registry row stays the operator's published-definition entry, so run-start
  // resolution never starts picking ephemeral per-run deployments. The returned
  // deployment is torn down when the run reaches a terminal status.
  provisionRunDeployment(
    args: ProvisionRunDeploymentArgs,
  ): Promise<{ deploymentId: string }>;
  // Idempotently ensure a deployment's supervisor is routable, re-establishing
  // it from persisted state (workflow repo + DB rows) when the hub's
  // addressIndex has lost it (hub restart) or the sidecar dropped it (sidecar
  // restart / idle-harness eviction). Revives the supervisor's agent + instance
  // rows if they were reaped (CL-2219) or ended by DELETE/undeploy convergence
  // (CL-2217/2222), then re-sends the supervisor deploy frame. Concurrent calls
  // for the same
  // deploymentId coalesce onto one re-establishment. The shared engine behind
  // the deployment reconciler and run-start/signal resilience.
  ensureDeploymentRoutable(
    args: EnsureDeploymentRoutableArgs,
  ): Promise<EnsureDeploymentRoutableResult>;
}

// Hub-owned multi-step workflow deploy: interchange's
// SessionService only deploys trivial single-step workflows, so we wire the
// exported orchestrator with the Workbench directors and our own repo writer.
// Tear a deployment's runtime down by id (CL-2582). Injected so the deploy
// service can roll back a partial per-run provision without importing the route
// layer; bound to `tearDownDeployment` in index.ts.
export type ReclaimDeploymentFn = (args: {
  deploymentId: string;
  tenantId: string;
  reason: string;
}) => Promise<void>;

export function createWorkflowDeployService(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
  sidecarRouter: SidecarRouter;
  directorRegistry: DirectorRegistry;
  // Optional: roll back a partial per-run deploy on failure. Absent in unit
  // tests that never exercise the failure path.
  reclaimDeployment?: ReclaimDeploymentFn;
  // Per-step deploy-tree stager (interchange `SessionService.stageWorkflowStep`):
  // for each multi-step step, resolves the step's pinned tool closure into a
  // `deploy/tool-packages-manifest.json` + asset tarballs and stages them on
  // disk at the step's address, so the sidecar materializes the step's tools
  // from disk (the on-disk model) rather than the retired hub-RPC manifest
  // fetch. Absent in unit tests / catalog-publish, where staging is a no-op.
  stageWorkflowStep?: LaunchSessionFn;
  // Single-step (one-step workflow) hand-off (interchange
  // `SessionService.deploySingleStepAtHead`): stages the head's deploy tree
  // (deploy-tree write, pack, asset fan-out) AND fires the deployment
  // `agent.deploy` frame in one call, mirroring `stageWorkflowStep` +
  // `sendMultiStepDeploy` collapsed onto a single head deploy. Absent in unit
  // tests / catalog-publish, where the single-step branch gets the no-op; a
  // production single-step provision that reaches the orchestrator's
  // single-step branch without this wired fails loud with
  // `SingleStepDeployHandoffMissingError` (thrown by the orchestrator itself,
  // mirroring `MultiStepDeployHandoffMissingError`).
  deploySingleStepAtHead?: DeploySingleStepFn;
}): WorkflowDeployService {
  const { db, directorRegistry } = deps;

  // Coalesce concurrent re-establishments of the same deployment. Reconnect,
  // run-start, signal, and the startup backstop can all fire for one
  // deploymentId at once; without this they would each see "not routable" and
  // race overlapping deploy frames at the sidecar. One in-flight promise per
  // deploymentId; callers await the shared result.
  const ensureInFlight = new Map<
    string,
    Promise<EnsureDeploymentRoutableResult>
  >();

  // Shared deploy body. `sendSupervisorFrame` gates the ONE sidecar hand-off:
  // true (per-run provisioning / re-establish) sends the supervisor
  // `agent.deploy` frame so the sidecar spawns the workflow-child; false
  // (catalog publish) writes the definition repo + DB/grant rows only and leaves
  // the sidecar untouched. Every other side effect — capability walk, tool-pin
  // resolution, per-step agent/instance/grant rows, deployment-level rows, the
  // git `workflow` repo write — runs identically in both modes.
  const runDeploy = async (
    params: DeployWorkflowParams,
    sendSupervisorFrame: boolean,
  ): Promise<DeployWorkflowResult> => {
    const walk = walkCapabilities(params.workflow, directorRegistry);
    // Pin the npm tool packages the workflow's steps declare so the sidecar
    // loader materializes them; the orchestrator forwards this same set to
    // every step launch.
    const toolPackagePins =
      params.toolPackagePins ??
      toolPackagesForCapabilities(capabilityNames(walk));

    // Partition every step into one of three classes by its CL-2251
    // `STEP_KIND_TAG`:
    //
    //   inline-inference (CL-2251) — a no-tool single-turn reasoning turn the
    //     sidecar runs in-process with a bare `createAgent`. NO `agent` row,
    //     NO `agent_instance` row, NO grants file, NO launchSession.
    //   deterministic-tool (CL-2252) — a tool/API call the sidecar runs
    //     against a deny-all `authorize` directly (no reactor, no session).
    //     The tool manifest/credentials endpoints gate on its `agent` row, so
    //     we KEEP `writeStepAgentRows` for it — but it needs NO instance row,
    //     NO grants file (the deny-all path never reads `grants.json`), and NO
    //     launchSession.
    //   deployed (reasoning with tools) — an `agent` row, an
    //     `agent_instance` row, and a `state/grants.json`. Execution reads its
    //     inputs from these hub-written artifacts: the agent def from
    //     workflow.json, the grants from `state/grants.json`, the tools from
    //     the on-disk deploy tree the per-step stager writes, and the
    //     credentials via the hub credential rail gated on the `agent` row.
    //
    // The orchestrator calls its per-step `launchSession` hook once per step.
    // In a production provision that hook is the on-disk tool stager
    // (`stageWorkflowStep`), which stages each step's pinned tool closure into
    // the deploy tree the sidecar materializes from disk; the catalog-publish
    // path passes a no-op instead (it touches no sidecar). Skipping the
    // inline/deterministic agent-state repos is the session-per-step RAM
    // saving carried over from the retired in-process runtime.
    const inlineStepIds = collectInlineStepIds(params.workflow);
    const deterministicStepIds = collectDeterministicToolStepIds(
      params.workflow,
    );
    const allStepIds = [...walk.perStep.keys()];
    const deployedStepIds = allStepIds.filter(
      (stepId) =>
        !inlineStepIds.has(stepId) && !deterministicStepIds.has(stepId),
    );
    // The orchestrator's per-step hook stages each step's tool tree on disk in
    // a production provision so the sidecar materializes the step's tools from
    // the deploy tree; the deploy also rebuilds each step from the other
    // hub-written artifacts (workflow.json, `state/grants.json`, the `agent`
    // row + the credential/grants hub rails) at execution time.

    // Persist `agent` rows UNIFORMLY for every step. Interchange's per-step
    // staging fires for every stepOrder entry and its pack phase records a
    // `session_asset` row (the tool-registry mount) whose FK chain requires
    // an active `agent_instance` row — which itself FKs the `agent` row. The
    // old inline/deterministic partitions repeatedly broke against those
    // upstream invariants (ack resolution, session_asset FK), so every
    // staged step now gets the full row pair; the rows are inert for steps
    // that never use them. The hub's tool-credential + manifest gate also
    // authorizes deterministic/deployed steps by this row's pins.
    const stepCapabilityNames = capabilityNames(walk);
    await writeStepAgentRows({
      db,
      deploymentId: params.deploymentId,
      tenantId: params.tenantId,
      creatorPrincipalId: params.creatorPrincipalId,
      stepIds: allStepIds,
      toolPackagePins,
      capabilityNames: stepCapabilityNames,
    });

    // Write each deployed step's `state/grants.json` into its agent-state
    // repo so both interchange's supervisor (credentialsSnapshot assembly)
    // and our sidecar's `readStepGrants` see real grants. Without this the
    // step agent's grant set is empty and every `tool:<name>`/`invoke` is
    // denied. Inline steps declare no tools, and deterministic tool steps run
    // against a hardcoded deny-all `authorize` that never consults
    // `grants.json` (CL-2252), so neither gets a grants file (nor an
    // agent-state repo to hold one).
    await writeStepGrantFiles({
      repoStore: deps.repoStore,
      deploymentId: params.deploymentId,
      stepIds: deployedStepIds,
      capabilityNames: stepCapabilityNames,
    });

    // Persist `agent_instance` rows UNIFORMLY for every step (matching the
    // agent-row write above). Interchange's pack phase inserts a
    // `session_asset` row per staged attachment with a hard FK to
    // `agent_instance` — a staged step without a row fails the whole
    // provision at phase "pack". Deploy acks no longer read these rows
    // (dep_-prefixed workflow addresses resolve against the
    // `workflow_deployment` projection), and CL-2705 per-step usage
    // attribution still joins them for reasoning steps; rows for inline /
    // deterministic steps are inert beyond the FK.
    //
    // Both `agent_instance` writers (step + supervisor) are gated on the
    // supervisor frame: a catalog publish spawns no supervisor and runs no
    // steps, so writing active (`endedAt` NULL) instance rows for it would
    // accumulate permanently-"live" phantom rows nothing ever ends. Per-run
    // deploys still write both.
    if (sendSupervisorFrame) {
      await writeStepInstanceRows({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        stepIds: allStepIds,
      });
    }

    // The orchestrator's multi-step branch also registers a
    // DEPLOYMENT-level supervisor address (`ins_<deploymentId>@<domain>`,
    // no step suffix) and fires the `agent.deploy` frame against it. The
    // sidecar's `agent.deploy.ack` for that frame resolves the supervisor
    // instance via `requireInstance` (by address, endedAt IS NULL) to store
    // its public key, and the supervisor's repo pack pushes route by the
    // same row. The per-step writers never create this row, so without it
    // the deploy fails with "No active instance found for address
    // ins_<deploymentId>@<domain>". Mirror the step writers: an `agent` row
    // (the instance's notNull FK target) plus the active instance row. The
    // instance row is frame-gated like the step rows (no supervisor, no ack,
    // no pack routing on a catalog publish); the `agent` row is kept in both
    // modes as the stable FK/naming anchor for the deployment id.
    await writeDeploymentAgentRow({
      db,
      deploymentId: params.deploymentId,
      tenantId: params.tenantId,
      creatorPrincipalId: params.creatorPrincipalId,
    });
    if (sendSupervisorFrame) {
      await writeDeploymentInstanceRow({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        harnessSessionId: params.config.sessionId,
      });
    }

    // Native workflow-deployment identity (interchange's model): every
    // published definition is anchored by a `workflow`-kind asset row, and
    // every live deployment carries a `workflow_deployment` projection row
    // keyed by its `dep_` id. Interchange's deploy-ack handler stores the
    // sidecar public key on this row (`isWorkflowDerivedAddress` routes
    // `ins_dep_...` addresses here, never through `agent_instance`), and the
    // reconnect ownership challenge reads it back from the same row —
    // without it every ack lands nowhere and reconnect fails closed. This
    // mirrors exactly what interchange's own `deployWorkflowDefinition`
    // writes; once the hub adopts that service wholesale this block is
    // deleted with the rest of runDeploy.
    const definitionAssetId = await ensureWorkflowDefinitionAsset({
      db,
      tenantId: params.tenantId,
      workflowId: params.workflow.id,
      creatorPrincipalId: params.creatorPrincipalId,
    });
    if (sendSupervisorFrame) {
      await writeWorkflowDeploymentRow({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        definitionAssetId,
        creatorPrincipalId: params.creatorPrincipalId,
      });
    }

    // The orchestrator walks every step (it pins each step's InferenceSource
    // into the supervisor frame's `sources` map, which the sidecar's
    // STEP_INFERENCE_SOURCES table reads — inline steps need that entry too)
    // and calls its `launchSession` hook once per step.
    // On-disk cutover: stage each multi-step step's pinned tool closure to
    // disk so the sidecar materializes it from the deploy tree. Catalog
    // publish (sendSupervisorFrame=false) must not touch the sidecar, so it
    // gets the no-op. A production provision (sendSupervisorFrame=true)
    // REQUIRES an injected stager: degrading it to the no-op when the stager
    // is absent would deploy every step with no staged tool tree and load
    // ZERO tools with no error — a silent-zero-tools regression. Fail loud on
    // that misconfiguration instead (the repo's no-silent-fallback rule).
    let stepStager: LaunchSessionFn;
    if (sendSupervisorFrame) {
      if (deps.stageWorkflowStep === undefined) {
        throw new Error(
          "workflow provision requires an injected stageWorkflowStep stager; without it every step would stage no tool tree and load zero tools",
        );
      }
      stepStager = deps.stageWorkflowStep;
    } else {
      stepStager = noLaunchStepSession;
    }

    // A one-step workflow definition routes through the orchestrator's
    // single-step branch, which requires its own hand-off: stage the head's
    // deploy tree AND fire the supervisor `agent.deploy` frame in one call
    // (`deps.deploySingleStepAtHead`, interchange's
    // `SessionService.deploySingleStepAtHead`). Catalog publish gets the
    // no-op, mirroring `sendMultiStepDeploy`. When a production provision
    // (sendSupervisorFrame=true) has no dep wired, the key is left out of the
    // orchestrator deps entirely (exactOptionalPropertyTypes forbids an
    // explicit `undefined`) — the orchestrator itself then fails loud with
    // `SingleStepDeployHandoffMissingError` if a single-step definition
    // actually reaches that branch, mirroring `MultiStepDeployHandoffMissingError`.
    let deploySingleStepAtHeadDep: DeploySingleStepFn | undefined;
    if (sendSupervisorFrame) {
      deploySingleStepAtHeadDep = deps.deploySingleStepAtHead;
    } else {
      deploySingleStepAtHeadDep = noopDeploySingleStepAtHead;
    }

    const orchestrator = createWorkflowDeployOrchestrator({
      directorRegistry,
      workflowRepo: createWorkflowRepoWriter(deps.repoStore),
      launchSession: stepStager,
      // Catalog publish (sendSupervisorFrame=false) hands the orchestrator a
      // no-op that resolves without touching the sidecar, so the workflow repo
      // + capability walk run but no `agent.deploy` frame is sent and no
      // supervisor spawns. Per-run provisioning passes the real hand-off.
      sendMultiStepDeploy: sendSupervisorFrame
        ? toSendMultiStepDeploy(deps.sidecarRouter)
        : noopSendMultiStepDeploy,
      ...(deploySingleStepAtHeadDep !== undefined
        ? { deploySingleStepAtHead: deploySingleStepAtHeadDep }
        : {}),
    });

    // Approve the workflow's own declared grants AND every inference source
    // the deploy resolved from the tenant catalog. Inline/deterministic steps
    // declare `sources:[]`, so the capability walk emits NO
    // `inference.source:*` grant for them; the orchestrator's
    // `pickStepInferenceSource` then refuses the catalog-resolved
    // `defaultSource` as unapproved. The catalog offerings ARE the
    // operator-approved set, so approving the chain is the correct gate.
    const operatorApprovals = new Set<string>([
      ...collectGrants(walk),
      ...params.config.sources.map(
        (source) => `inference.source:${source.provider}:${source.model}`,
      ),
    ]);

    const deployResult = await orchestrator.deployWorkflow({
      ...params,
      operatorApprovals,
      toolPackagePins,
    });
    return deployResult;
  };

  const service: WorkflowDeployService = {
    deployWorkflow: (params) => runDeploy(params, true),

    persistCatalog: (params) => runDeploy(params, false),

    ensureDeploymentRoutable: async (args) => {
      const address = deriveDeploymentAddress({
        deploymentId: args.deploymentId,
        deploymentDomain: args.deploymentDomain,
      });
      if (deps.sidecarRouter.getRoutableAddresses().includes(address)) {
        return { reestablished: false };
      }

      const existing = ensureInFlight.get(args.deploymentId);
      if (existing !== undefined) return existing;

      const run = reestablishSupervisor({
        db,
        repoStore: deps.repoStore,
        sidecarRouter: deps.sidecarRouter,
        args,
      });
      ensureInFlight.set(args.deploymentId, run);
      try {
        return await run;
      } finally {
        ensureInFlight.delete(args.deploymentId);
      }
    },

    provisionRunDeployment: async (args) => {
      const definition = await readWorkflowDefinition(
        deps.repoStore,
        args.kind,
      );
      const { deploymentId, config, deployContent } =
        await resolveWorkflowDeployConfig({
          db,
          tenantId: args.tenantId,
          principalId: args.creatorPrincipalId,
          deploymentDomain: args.deploymentDomain,
          definition,
        });
      try {
        await service.deployWorkflow({
          workflow: definition,
          deploymentId,
          deploymentDomain: args.deploymentDomain,
          tenantId: args.tenantId,
          creatorPrincipalId: args.creatorPrincipalId,
          config,
          deployContent,
          hubPublicKey: args.hubPublicKey,
        });
      } catch (err) {
        // Roll back the partial deploy so a provision failure leaves no orphaned
        // supervisor/step rows (CL-2582 Step D, class 1). Best-effort; the
        // original error is what the caller sees.
        if (deps.reclaimDeployment !== undefined) {
          await deps
            .reclaimDeployment({
              deploymentId,
              tenantId: args.tenantId,
              reason: "per-run provision failed",
            })
            .catch((reclaimErr) => {
              log.warn("per-run provision rollback failed", {
                deploymentId,
                error:
                  reclaimErr instanceof Error
                    ? reclaimErr.message
                    : String(reclaimErr),
              });
            });
        }
        throw err;
      }
      log.info("provisioned per-run workflow deployment", {
        deploymentId,
        kind: args.kind,
        tenantId: args.tenantId,
      });
      return { deploymentId };
    },
  };
  return service;
}

// Re-establish a deployment's supervisor from persisted state by re-sending
// ONLY the supervisor `agent.deploy` frame.
//
// We deliberately do NOT go through the orchestrator's deployWorkflow: it
// re-launches every step session first, and a step's deploy frame takes the
// sidecar's trivial branch → `provisionAgent`, which throws "Agent already
// exists" for the still-present step sessions (they self-restore on a sidecar
// restart and stay alive on a hub restart). Re-driving the full deploy would
// therefore throw before the supervisor frame is ever sent. The supervisor is
// the only thing the hub lost from its addressIndex; the steps, grants files,
// workflow repo, and DB rows are all already persisted from the original
// deploy. Sending the supervisor frame alone re-registers the address (the
// sidecar-handler sets addressIndex on send) and the sidecar's deploy router
// re-spawns or idempotently re-confirms the supervisor child.
async function reestablishSupervisor(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
  sidecarRouter: SidecarRouter;
  args: EnsureDeploymentRoutableArgs;
}): Promise<EnsureDeploymentRoutableResult> {
  const { args } = deps;
  const definition = await readWorkflowDefinition(deps.repoStore, args.kind);
  const sources = await resolveWorkflowDeploySource({
    db: deps.db,
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
    extraModels: collectDeclaredStepModels(definition),
    modelMaxTokens: collectDeclaredStepModelMaxTokens(definition),
  });

  // Revive the supervisor's agent + instance rows before re-sending the deploy
  // frame. The original deploy wrote these rows, but a re-establish runs against
  // the SAME deploymentId after the supervisor instance was reaped by
  // idle-harness eviction (CL-2219) or ended by DELETE/undeploy convergence
  // (CL-2217/2222) while the `workflow_run` row stayed active. Without an active
  // instance row, the `agent.deploy.ack` handler's `requireInstance` throws "No
  // active instance found for address", which rejects `sendAgentDeploy` and
  // 500s the run-start (CL-2227). This ensure is idempotent: a no-op when the
  // row is already active, a revive when it was ended/reaped.
  const supervisorAgentId = deriveDeploymentAgentId(args.deploymentId);
  const existingSupervisor = await deps.db.query.agentInstance.findFirst({
    where: eq(intxSchema.agentInstance.id, supervisorAgentId),
  });

  const { address, config, workflow } = buildSupervisorDeployFrame({
    deploymentId: args.deploymentId,
    deploymentDomain: args.deploymentDomain,
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
    definition,
    sources,
    ...(typeof existingSupervisor?.sessionId === "string" &&
    existingSupervisor.sessionId.length > 0
      ? { harnessSessionId: existingSupervisor.sessionId }
      : {}),
  });

  await ensureDeploymentInstanceActive({
    db: deps.db,
    deploymentId: args.deploymentId,
    deploymentDomain: args.deploymentDomain,
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
    harnessSessionId: config.sessionId,
  });
  await deps.sidecarRouter.sendAgentDeploy(address, config, workflow);

  log.info("re-established workflow supervisor", {
    deploymentId: args.deploymentId,
    kind: args.kind,
    tenantId: args.tenantId,
  });
  return { reestablished: true };
}

// Build the deployment-level (supervisor) `agent.deploy` frame inputs for a
// re-drive: the deployment address, the supervisor's HarnessConfig (base config
// with the agentAddress/agentId overridden to the deployment level, exactly as
// the orchestrator's multi-step branch does), and the workflow projection
// (definition + per-step inference sources). Pure function of its inputs so the
// address/config/sources derivation is unit-testable without a sidecar.
//
// A step that declares no model preference pins the tenant catalog chain head;
// a `step` primitive whose agent declares a preferred (provider, model) pins the
// matching resolved source (see pickFrameStepSource — it mirrors the deploy
// orchestrator's pickStepInferenceSource so the fresh-deploy and re-drive paths
// agree). Runtime cross-source failover is still not wired in the workflow path
// (one source is pinned per step into STEP_INFERENCE_SOURCES); when that lands
// upstream this gains the full per-step routing chain.
// Mirror the deploy orchestrator's `pickStepInferenceSource` for the re-drive
// frame: a `step` primitive whose agent declares a preferred (provider, model)
// inference source pins the matching entry from the resolved source set; every
// other step — and any non-agent primitive (gate, sleep, awaitSignal, …) — falls
// back to the chain head. This keeps a re-established supervisor's per-step model
// assignment identical to the original deploy (so e.g. a writer step stays on its
// heavier model across an eviction/re-establish).
function pickFrameStepSource(
  primitive: WorkflowPrimitive | undefined,
  sources: InferenceSource[],
  head: InferenceSource,
): InferenceSource {
  if (primitive === undefined || primitive.kind !== "step") return head;
  // Defensive read: the primitive is reconstructed from persisted JSON, so guard
  // against a step that carries no agent/source rather than the typed shape.
  const preferred = primitive.agent?.inference?.sources?.[0];
  if (preferred === undefined) return head;
  const match = sources.find(
    (s) => s.provider === preferred.provider && s.model === preferred.model,
  );
  return match ?? head;
}

export function buildSupervisorDeployFrame(args: {
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  creatorPrincipalId: string;
  definition: WorkflowDefinition;
  sources: InferenceSource[];
  harnessSessionId?: string;
}): {
  address: string;
  config: HarnessConfig;
  workflow: {
    definition: AgentDeployWorkflow["definition"];
    sources: Record<string, InferenceSource[]>;
  };
} {
  const address = deriveDeploymentAddress({
    deploymentId: args.deploymentId,
    deploymentDomain: args.deploymentDomain,
  });
  const { config } = assembleWorkflowDeployConfig({
    deploymentId: args.deploymentId,
    tenantId: args.tenantId,
    principalId: args.creatorPrincipalId,
    deploymentDomain: args.deploymentDomain,
    sources: args.sources,
  });
  const deploymentConfig: HarnessConfig = {
    ...config,
    agentAddress: address,
    agentId: deriveDeploymentAgentId(args.deploymentId),
    ...(args.harnessSessionId !== undefined
      ? { sessionId: args.harnessSessionId }
      : {}),
  };
  const [head] = args.sources;
  if (head === undefined) {
    throw new Error(
      "workflow deploy: cannot build supervisor frame with no inference sources",
    );
  }
  // The deploy frame's `sources` map is now keyed by step id to a NON-EMPTY
  // array of inference sources (upstream source-array + live-rotation change).
  // The workflow path still pins exactly one source per step, so each entry is
  // a single-element array; the runtime failover chain lands when upstream
  // wires per-step routing into the workflow child.
  const sources: Record<string, InferenceSource[]> = {};
  for (const stepId of args.definition.stepOrder) {
    sources[stepId] = [
      pickFrameStepSource(args.definition.steps[stepId], args.sources, head),
    ];
  }
  return {
    address,
    config: deploymentConfig,
    workflow: {
      definition: args.definition as AgentDeployWorkflow["definition"],
      sources,
    },
  };
}

// Read the deployed workflow definition back from its `workflow`-kind repo
// working tree. `writeTree` materializes `workflow.json` via fs.writeFile on the
// durable hub data dir (no git checkout), and `getRepoDir` is a pure path
// computation, so the file survives a hub restart — the same working-tree-read
// pattern the sidecar spawn-child and hub skill library use. Validated through
// the same envelope schema the deploy route parses request bodies with, so a
// missing or drifted file fails loudly at the boundary rather than reaching the
// sidecar as an unchecked cast.
// Parsed+validated definition cache (CL-2760). readFile + JSON.parse + full
// arktype envelope validation ran on every provision and every re-establish.
// The definition on disk is immutable until an operator redeploys the workflow
// (which rewrites workflow.json, bumping its mtime), so memoizing by (kind,
// mtimeMs) reuses the validated result while the file is unchanged and
// re-parses the moment it changes. The cheap `stat` still runs each call — only
// the readFile + parse + validate is skipped. In-process only.
//
// A TTL backstop caps how long a (kind, mtimeMs) entry may serve: a
// checkout/restore that preserves mtime while changing content would otherwise
// serve a stale definition indefinitely. Once the TTL elapses the entry is
// re-read and re-validated even if mtime is unchanged.
type WorkflowDefinitionCacheEntry = {
  mtimeMs: number;
  storedAt: number;
  definition: WorkflowDefinition;
};
const workflowDefinitionCache = new Map<string, WorkflowDefinitionCacheEntry>();

/** Test-only: clears the parsed workflow-definition cache. */
export function resetWorkflowDefinitionCache(): void {
  workflowDefinitionCache.clear();
}

export async function readWorkflowDefinition(
  repoStore: AgentRepoStore,
  kind: string,
  opts?: { now?: () => number; ttlMs?: number },
): Promise<WorkflowDefinition> {
  const dir = repoStore.repoStore.getRepoDir({ kind: "workflow", id: kind });
  const path = join(dir, WORKFLOW_JSON_PATH);
  const clock = opts?.now ?? Date.now;
  const ttlMs = opts?.ttlMs ?? getConfig().workflowDeploy.definitionCacheTtlMs;

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    // Fall through to readFile so the existing missing-file error message (which
    // callers depend on) is the one surfaced, rather than a stat error.
    mtimeMs = undefined;
  }

  if (mtimeMs !== undefined) {
    const cached = workflowDefinitionCache.get(kind);
    if (
      cached !== undefined &&
      cached.mtimeMs === mtimeMs &&
      clock() - cached.storedAt < ttlMs
    ) {
      // Clone on the way out: the definition flows by reference into the
      // external @intx/workflow-deploy seam, so the cached copy must stay
      // read-only and immune to cross-run mutation.
      return structuredClone(cached.definition);
    }
  }

  let parsedJson: unknown;
  try {
    const raw = await readFile(path, "utf8");
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `cannot re-establish workflow "${kind}": ${WORKFLOW_JSON_PATH} is missing or unreadable in its workflow repo (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  const parsed = workflowDefinitionEnvelopeSchema(parsedJson);
  if (parsed instanceof type.errors) {
    throw new Error(
      `cannot re-establish workflow "${kind}": persisted definition is invalid: ${parsed.summary}`,
    );
  }
  const definition = parsed as WorkflowDefinition;
  if (mtimeMs !== undefined) {
    workflowDefinitionCache.set(kind, {
      mtimeMs,
      storedAt: clock(),
      definition,
    });
  }
  // Clone the fresh result too so the cached copy can never be reached by
  // reference through the returned value.
  return structuredClone(definition);
}

// Persist a per-step `agent` row so the tool-credential gate can authorize each
// step's harness from its pinned packages, exactly as it does for any agent.
export async function writeStepAgentRows(args: {
  db: HubDb;
  deploymentId: string;
  tenantId: string;
  creatorPrincipalId: string;
  stepIds: readonly string[];
  toolPackagePins: readonly ToolPackagePin[];
  capabilityNames: readonly string[];
}): Promise<void> {
  if (args.stepIds.length === 0) return;
  const now = new Date();
  const rows = args.stepIds.map((stepId) => ({
    id: deriveStepAgentId({ deploymentId: args.deploymentId, stepId }),
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
    name: stepId,
    capabilities: { tools: [...args.capabilityNames] },
    toolPackages: [...args.toolPackagePins],
    status: "deployed" as const,
    createdAt: now,
    updatedAt: now,
  }));
  await args.db.insert(intxSchema.agent).values(rows);
}

// Persist a per-step `agent_instance` row keyed by the orchestrator's derived
// step ids. Mirrors the row interchange's native deploy route writes before
// launch (hub-api instances.ts): the deploying user's principal owns the
// instance (the orchestrator keeps `config.principalId` per step), and the
// public key lands here once the sidecar acks the deploy. Interchange derives a
// step's instance id and agent id from `(deploymentId, stepId)` to the same
// value (`deriveStepInstanceId` === `deriveStepAgentId`) and only exports the
// latter, so we use it for both; the deploy-ack handler resolves the row by
// `address`, not by id.
//
// Not idempotent on a re-deploy of the SAME deploymentId: `id` (PK) and
// `address` (unique) are deterministic, so a colliding deploymentId throws.
// Safe in practice — resolveWorkflowDeployConfig mints a fresh deploymentId per
// deploy — matching interchange's equally non-idempotent native deploy route.
export async function writeStepInstanceRows(args: {
  db: HubDb;
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  creatorPrincipalId: string;
  stepIds: readonly string[];
}): Promise<void> {
  if (args.stepIds.length === 0) return;
  const now = new Date();
  const rows = args.stepIds.map((stepId) => ({
    id: deriveStepAgentId({ deploymentId: args.deploymentId, stepId }),
    agentId: deriveStepAgentId({ deploymentId: args.deploymentId, stepId }),
    tenantId: args.tenantId,
    principalId: args.creatorPrincipalId,
    address: deriveStepAddress({
      deploymentId: args.deploymentId,
      stepId,
      deploymentDomain: args.deploymentDomain,
    }),
    status: "deployed" as const,
    createdAt: now,
    updatedAt: now,
  }));
  await args.db.insert(intxSchema.agentInstance).values(rows);
}

// The deployment-level agent id the orchestrator derives for the supervisor.
// `@intx/workflow-deploy` exports `deriveDeploymentAddress` but not the agent
// id helper (`deriveDeploymentAgentId`), whose formula is the address's
// local-part: `ins_<deploymentId>` — the same shape `deriveStepAgentId`
// produces minus the step suffix. Replicated here so the backing `agent` row
// and the instance row's `agentId` match what the orchestrator puts on the
// `agent.deploy` frame's `agentId` field.
function deriveDeploymentAgentId(deploymentId: string): string {
  return `ins_${deploymentId}`;
}

async function ensureHarnessSessionRow(args: {
  db: HubDb;
  sessionId: string;
  tenantId: string;
  agentId: string;
  principalId: string;
}): Promise<void> {
  const now = new Date();
  await args.db
    .insert(intxSchema.agentSession)
    .values({
      id: args.sessionId,
      tenantId: args.tenantId,
      agentId: args.agentId,
      principalId: args.principalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: intxSchema.agentSession.id });
}

// Persist the deployment-level (supervisor) `agent` row. The instance row's
// `agentId` has a notNull FK to `agent.id`, so this must exist before the
// supervisor instance row is written. Mirrors `writeStepAgentRows`' field set
// at the deployment agent id.
export async function writeDeploymentAgentRow(args: {
  db: HubDb;
  deploymentId: string;
  tenantId: string;
  creatorPrincipalId: string;
}): Promise<void> {
  const now = new Date();
  // The supervisor runs the workflow-host child, not a tool-capable harness —
  // it never loads tool packages (the per-step agents do). This row exists
  // only to satisfy the instance row's notNull `agentId` FK and to let
  // `requireInstance` resolve the supervisor address, so it declares no
  // capabilities and no tool packages.
  await args.db.insert(intxSchema.agent).values({
    id: deriveDeploymentAgentId(args.deploymentId),
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
    name: `supervisor-${args.deploymentId}`,
    capabilities: null,
    toolPackages: [],
    status: "deployed" as const,
    createdAt: now,
    updatedAt: now,
  });
}

// Persist the deployment-level (supervisor) `agent_instance` row keyed by the
// deployment address `ins_<deploymentId>@<deploymentDomain>` (no step suffix).
// The orchestrator's multi-step branch fires the `agent.deploy` frame against
// this address; the sidecar's `agent.deploy.ack` resolves the row via
// `requireInstance` (matching on `address` with `endedAt IS NULL`) to store
// the supervisor's public key, and pack pushes for the supervisor route by the
// same row. `endedAt` is left NULL — the row is active. Mirrors
// `writeStepInstanceRows`, and shares its non-idempotency: `id`/`address` are
// deterministic on the deploymentId, so a re-deploy of the SAME deploymentId
// throws on the unique `address`. Safe in practice — a fresh deploymentId is
// minted per deploy (resolveWorkflowDeployConfig).
export async function writeDeploymentInstanceRow(args: {
  db: HubDb;
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  creatorPrincipalId: string;
  harnessSessionId: string;
}): Promise<void> {
  const now = new Date();
  const agentId = deriveDeploymentAgentId(args.deploymentId);
  await ensureHarnessSessionRow({
    db: args.db,
    sessionId: args.harnessSessionId,
    tenantId: args.tenantId,
    agentId,
    principalId: args.creatorPrincipalId,
  });
  await args.db.insert(intxSchema.agentInstance).values({
    id: agentId,
    agentId,
    tenantId: args.tenantId,
    principalId: args.creatorPrincipalId,
    sessionId: args.harnessSessionId,
    address: deriveDeploymentAddress({
      deploymentId: args.deploymentId,
      deploymentDomain: args.deploymentDomain,
    }),
    status: "deployed" as const,
    createdAt: now,
    updatedAt: now,
  });
}

// Native catalog identity: every published workflow definition is anchored by
// a `workflow`-kind `asset` row (interchange's authoring model — its deploy
// route hydrates definitions from these assets). The workbench still authors
// definition content through its own registry, so this upsert converges the
// IDENTITY first; content authoring moves onto the asset substrate with the
// full native-service adoption. Idempotent on (tenantId, "workflow", name).
export async function ensureWorkflowDefinitionAsset(args: {
  db: HubDb;
  tenantId: string;
  workflowId: string;
  creatorPrincipalId: string;
}): Promise<string> {
  const inserted = await args.db
    .insert(intxSchema.asset)
    .values({
      id: generateId("asset"),
      tenantId: args.tenantId,
      kind: "workflow",
      name: args.workflowId,
      creatorPrincipalId: args.creatorPrincipalId,
    })
    .onConflictDoNothing()
    .returning({ id: intxSchema.asset.id });
  const freshId = inserted[0]?.id;
  if (freshId !== undefined) return freshId;
  const row = await args.db
    .select({ id: intxSchema.asset.id })
    .from(intxSchema.asset)
    .where(
      and(
        eq(intxSchema.asset.tenantId, args.tenantId),
        eq(intxSchema.asset.kind, "workflow"),
        eq(intxSchema.asset.name, args.workflowId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined) {
    throw new Error(
      `workflow definition asset for "${args.workflowId}" missing after upsert`,
    );
  }
  return row.id;
}

// Native deployment projection: the `workflow_deployment` row interchange's
// `deployWorkflowDefinition` writes, mirrored field-for-field. The deploy-ack
// handler persists the sidecar's minted public key onto this row
// (`isWorkflowDerivedAddress` routes every `ins_dep_...` ack here), and the
// reconnect ownership challenge reads the key back from it. The creator read
// grant mirrors the native path so the deploying principal can observe run
// events. Idempotent for re-establishment: the row insert no-ops on the
// existing address, and the grant is only seeded when the row was actually
// inserted (a re-establish reuses the original deploy's grant).
export async function writeWorkflowDeploymentRow(args: {
  db: HubDb;
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  definitionAssetId: string;
  creatorPrincipalId: string;
}): Promise<void> {
  const now = new Date();
  const inserted = await args.db
    .insert(intxSchema.workflowDeployment)
    .values({
      id: args.deploymentId,
      tenantId: args.tenantId,
      definitionAssetId: args.definitionAssetId,
      address: deriveDeploymentAddress({
        deploymentId: args.deploymentId,
        deploymentDomain: args.deploymentDomain,
      }),
      status: "deployed" as const,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: intxSchema.workflowDeployment.id });
  if (inserted.length === 0) return;
  await args.db.insert(intxSchema.grant).values({
    id: generateId("grant"),
    tenantId: args.tenantId,
    principalId: args.creatorPrincipalId,
    resource: `workflow-run:${args.deploymentId}`,
    action: "read",
    effect: "allow",
    origin: "creator",
    createdAt: now,
    updatedAt: now,
  });
}

// Idempotently ensure the deployment-level supervisor `agent` + `agent_instance`
// rows exist and are ACTIVE (`endedAt` cleared) before a re-establish sends the
// supervisor deploy frame. Unlike `writeDeploymentAgentRow`/
// `writeDeploymentInstanceRow` (which throw on a duplicate as a fresh-
// deploymentId safety check on the first deploy), this runs on the re-establish
// path with the SAME deploymentId: the supervisor instance row may have been
// reaped by idle-harness eviction (CL-2219) or ended by DELETE/undeploy
// convergence (CL-2217/2222) while the `workflow_run` row stayed active. The
// agent.deploy.ack handler resolves the supervisor via `requireInstance`
// (address + `endedAt IS NULL`); a missing or ended row throws "No active
// instance found for address" and 500s the run-start (CL-2227). Reviving the row
// here makes re-establish — and therefore every NEW run — succeed.
export async function ensureDeploymentInstanceActive(args: {
  db: HubDb;
  deploymentId: string;
  deploymentDomain: string;
  tenantId: string;
  creatorPrincipalId: string;
  harnessSessionId?: string;
}): Promise<void> {
  const now = new Date();
  const agentId = deriveDeploymentAgentId(args.deploymentId);
  if (args.harnessSessionId !== undefined) {
    await ensureHarnessSessionRow({
      db: args.db,
      sessionId: args.harnessSessionId,
      tenantId: args.tenantId,
      agentId,
      principalId: args.creatorPrincipalId,
    });
  }
  await args.db
    .insert(intxSchema.agent)
    .values({
      id: agentId,
      tenantId: args.tenantId,
      creatorPrincipalId: args.creatorPrincipalId,
      name: `supervisor-${args.deploymentId}`,
      capabilities: null,
      toolPackages: [],
      status: "deployed" as const,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: intxSchema.agent.id });
  const instanceSet: {
    status: "deployed";
    endedAt: null;
    updatedAt: Date;
    sessionId?: string;
  } = { status: "deployed" as const, endedAt: null, updatedAt: now };
  if (args.harnessSessionId !== undefined) {
    instanceSet.sessionId = args.harnessSessionId;
  }

  await args.db
    .insert(intxSchema.agentInstance)
    .values({
      id: agentId,
      agentId,
      tenantId: args.tenantId,
      principalId: args.creatorPrincipalId,
      sessionId: args.harnessSessionId ?? null,
      address: deriveDeploymentAddress({
        deploymentId: args.deploymentId,
        deploymentDomain: args.deploymentDomain,
      }),
      status: "deployed" as const,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: intxSchema.agentInstance.id,
      set: instanceSet,
    });
}

// Build the on-disk `GrantRule` set that authorizes a step agent to invoke
// each of its tools. This is the runtime grammar `@intx/authz`'s
// `evaluateGrants` matches (NOT a DB `grant` row) — it mirrors
// `buildToolGrantRows` but emits the `GrantRule` shape the sidecar evaluates
// off `state/grants.json`. One allow rule per de-duplicated tool name.
export function buildStepGrantRules(
  capabilityNames: readonly string[],
): GrantRule[] {
  const unique = [...new Set(capabilityNames)];
  return unique.map((name) => ({
    id: generateId("grant"),
    resource: `${TOOL_GRANT_RESOURCE_PREFIX}${name}`,
    action: "invoke",
    effect: "allow" as const,
    origin: "system" as const,
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  }));
}

// Persist each step's grants snapshot to its agent-state repo. Every step's
// agent gets the same union capability set the deploy resolved, expressed as
// `tool:<name>`/`invoke` allow rules.
export async function writeStepGrantFiles(args: {
  repoStore: AgentRepoStore;
  deploymentId: string;
  stepIds: readonly string[];
  capabilityNames: readonly string[];
}): Promise<void> {
  if (args.stepIds.length === 0) return;
  const grants = buildStepGrantRules(args.capabilityNames);
  const contents = JSON.stringify({ grants });
  for (const stepId of args.stepIds) {
    const repoId = `${args.deploymentId}-${stepId}`;
    await args.repoStore.repoStore.writeTree(
      { kind: "hub" },
      { kind: "agent-state", id: repoId },
      STEP_GRANTS_REF,
      {
        files: { [STEP_GRANTS_PATH]: contents },
        message: `Write step grants for ${repoId}`,
      },
    );
  }
}

export function createWorkflowRepoWriter(
  repoStore: AgentRepoStore,
): WorkflowRepoWriter {
  return {
    // writeTree auto-inits the repo; the orchestrator supplies the only
    // entries the workflow-kind handler allows.
    async writeWorkflowRepo({ workflowRepoId, files }) {
      await repoStore.repoStore.writeTree(
        { kind: "hub" },
        { kind: "workflow", id: workflowRepoId },
        WORKFLOW_DEPLOY_REF,
        {
          files: Object.fromEntries(files),
          message: `Deploy workflow ${workflowRepoId}`,
        },
      );
    },
  };
}

// Project a workflow primitive to its agent definition when it carries one.
// Mirrors interchange's `extractAgent` (capability-walk.ts): `step` and `map`
// are the agent-carrying shapes; every other primitive has no agent.
function extractStepAgent(
  primitive: WorkflowPrimitive | undefined,
): AgentDefinition<BaseEnv> | null {
  if (primitive === undefined) return null;
  if (primitive.kind === "step") return primitive.agent;
  if (primitive.kind === "map") return primitive.step.agent;
  return null;
}

// The step ids whose agent carries the inline-inference marker tag (CL-2251).
// These steps are NOT deployed as per-step sessions: the hub skips their
// agent/instance/grants writers and no-ops their `launchSession`.
export function collectInlineStepIds(
  workflow: WorkflowDefinition,
): Set<string> {
  const inline = new Set<string>();
  for (const stepId of workflow.stepOrder) {
    const primitive = workflow.steps[stepId];
    const agent = extractStepAgent(primitive);
    if (agent?.tags?.[STEP_KIND_TAG] === INLINE_INFERENCE_KIND) {
      inline.add(stepId);
    }
  }
  return inline;
}

// The step ids whose agent carries the deterministic-tool marker tag (CL-2252).
// These steps run a tool/API call against a hardcoded deny-all `authorize` with
// no reactor and no session: the hub keeps their `agent` row (the tool
// manifest/credentials endpoints gate on it) but skips their instance row and
// grants file and no-ops their `launchSession`.
export function collectDeterministicToolStepIds(
  workflow: WorkflowDefinition,
): Set<string> {
  const deterministic = new Set<string>();
  for (const stepId of workflow.stepOrder) {
    const primitive = workflow.steps[stepId];
    const agent = extractStepAgent(primitive);
    if (agent?.tags?.[STEP_KIND_TAG] === DETERMINISTIC_TOOL_KIND) {
      deterministic.add(stepId);
    }
  }
  return deterministic;
}

// The orchestrator requires a per-step `launchSession` hook, but upstream
// retired the in-process session runtime: a workflow step is never launched as
// its own warm session. Execution rebuilds each step from the hub-written
// artifacts (workflow.json, `state/grants.json`, the `agent` row + hub RPC), so
// the hook resolves immediately without touching a sidecar. Named (not inline)
// so a step launch can never regress into a real session by accident.
const noLaunchStepSession: LaunchSessionFn = () => Promise.resolve();

// Catalog-publish hand-off: satisfies the orchestrator's required
// `sendMultiStepDeploy` dep without sending an `agent.deploy` frame. The
// orchestrator writes the workflow repo and walks steps, then awaits this and
// returns; no supervisor is spawned. The returned `publicKey` is empty — no
// sidecar acked a deploy, and the catalog path (publishWorkflowDefinition)
// ignores it (the per-run deploy is where a real supervisor pubkey is minted).
const noopSendMultiStepDeploy: SendMultiStepDeployFn = () =>
  Promise.resolve({ publicKey: "" });

// Single-step counterpart to `noopSendMultiStepDeploy` for the catalog-publish
// path (sendSupervisorFrame=false): the orchestrator writes the workflow repo
// and walks the sole step, then awaits this without firing any deploy frame.
const noopDeploySingleStepAtHead: DeploySingleStepFn = () =>
  Promise.resolve({ publicKey: "" });

export function toSendMultiStepDeploy(
  sidecarRouter: SidecarRouter,
): SendMultiStepDeployFn {
  return ({ agentAddress, config, definition, sources }) =>
    sidecarRouter.sendAgentDeploy(agentAddress, config, {
      // XXX: cast bridges @intx/workflow's WorkflowDefinition and the deploy
      // frame's definition — today they differ only by exactOptional variance on
      // `state`. If a pin bump changes AgentDeployWorkflow's shape, this cast
      // hides it: re-verify on every interchange bump (see the pin-bump
      // policy in AGENTS.md).
      definition: definition as AgentDeployWorkflow["definition"],
      sources,
    });
}

// The hub is the operator: a workflow it chose to deploy is approved for the
// grants its own definition declares.
export function collectGrants(walk: CapabilityWalkResult): ReadonlySet<string> {
  const grants = new Set<string>();
  for (const { grants: stepGrants } of walk.perStep.values()) {
    for (const grant of stepGrants) {
      grants.add(grant);
    }
  }
  return grants;
}

// The tool capability names the walk surfaced across all steps (the `capability:`
// grants, stripped of their prefix), used to resolve the deploy's tool packages.
export function capabilityNames(walk: CapabilityWalkResult): string[] {
  const names = new Set<string>();
  for (const { grants } of walk.perStep.values()) {
    for (const grant of grants) {
      if (grant.startsWith("capability:")) {
        names.add(grant.slice("capability:".length));
      }
    }
  }
  return [...names];
}
