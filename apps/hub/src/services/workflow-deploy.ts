import {
  createWorkflowDeployOrchestrator,
  deriveDeploymentAddress,
  deriveStepAddress,
  deriveStepAgentId,
  walkCapabilities,
  type CapabilityWalkResult,
  type DeployWorkflowResult,
  type LaunchSessionFn,
  type SendMultiStepDeployFn,
  type WorkflowRepoWriter,
} from "@intx/workflow-deploy";
import type { DirectorRegistry } from "@intx/agent";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/authz";
import { toolPackagesForCapabilities } from "@workbench/agents";
import type { HubDb } from "../db";
import type { WorkflowDefinition } from "@intx/workflow";
import type { HarnessConfig } from "@intx/types/runtime";
import type { AgentDeployWorkflow } from "@intx/types/sidecar";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type {
  AgentRepoStore,
  DeployContent,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

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

export interface WorkflowDeployService {
  deployWorkflow(params: DeployWorkflowParams): Promise<DeployWorkflowResult>;
}

// Hub-owned multi-step workflow deploy: interchange's
// SessionService only deploys trivial single-step workflows, so we wire the
// exported orchestrator with the Workbench directors and our own repo writer.
export function createWorkflowDeployService(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
  sidecarRouter: SidecarRouter;
  sessionService: SessionService;
  directorRegistry: DirectorRegistry;
}): WorkflowDeployService {
  const { db, directorRegistry } = deps;
  const orchestrator = createWorkflowDeployOrchestrator({
    directorRegistry,
    workflowRepo: createWorkflowRepoWriter(deps.repoStore),
    launchSession: toLaunchSession(deps.sessionService),
    sendMultiStepDeploy: toSendMultiStepDeploy(deps.sidecarRouter),
  });

  return {
    deployWorkflow: async (params) => {
      const walk = walkCapabilities(params.workflow, directorRegistry);
      // Pin the npm tool packages the workflow's steps declare so the sidecar
      // loader materializes them; the orchestrator forwards this same set to
      // every step launch.
      const toolPackagePins =
        params.toolPackagePins ??
        toolPackagesForCapabilities(capabilityNames(walk));

      // Each step launches as its own agent (`deriveStepAgentId`), but
      // interchange's launchSession never writes an `agent` row. The hub's
      // tool-credential gate authorizes a step's harness by that row's pins, so
      // we persist one per step before launch — every step carries the same
      // union pins the orchestrator hands it.
      const stepCapabilityNames = capabilityNames(walk);
      await writeStepAgentRows({
        db,
        deploymentId: params.deploymentId,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        stepIds: [...walk.perStep.keys()],
        toolPackagePins,
        capabilityNames: stepCapabilityNames,
      });

      // Write each step's `state/grants.json` into its agent-state repo so
      // both interchange's supervisor (credentialsSnapshot assembly) and our
      // sidecar's `readStepGrants` see real grants. Without this the step
      // agent's grant set is empty and every `tool:<name>`/`invoke` is denied.
      await writeStepGrantFiles({
        repoStore: deps.repoStore,
        deploymentId: params.deploymentId,
        stepIds: [...walk.perStep.keys()],
        capabilityNames: stepCapabilityNames,
      });

      // Persist a per-step `agent_instance` row before the orchestrator
      // launches each step. Interchange's launch callbacks deliberately do no
      // DB writes — the native single-agent route creates the instance row
      // itself before `launchSession` (hub-api instances.ts), and the
      // `agent.deploy.ack` handler then resolves it via `requireInstance` to
      // store the step's public key. The orchestrator runs the same launch
      // path, so without this row every step deploy fails with "No active
      // instance found for address".
      await writeStepInstanceRows({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        stepIds: [...walk.perStep.keys()],
      });

      // The orchestrator's multi-step branch also registers a
      // DEPLOYMENT-level supervisor address (`ins_<deploymentId>@<domain>`,
      // no step suffix) and fires the `agent.deploy` frame against it. The
      // sidecar's `agent.deploy.ack` for that frame resolves the supervisor
      // instance via `requireInstance` (by address, endedAt IS NULL) to store
      // its public key, and the supervisor's repo pack pushes route by the
      // same row. The per-step writers never create this row, so without it
      // the deploy fails with "No active instance found for address
      // ins_<deploymentId>@<domain>". Mirror the step writers: an `agent` row
      // (the instance's notNull FK target) plus the active instance row.
      await writeDeploymentAgentRow({
        db,
        deploymentId: params.deploymentId,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
      });
      await writeDeploymentInstanceRow({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
      });

      return orchestrator.deployWorkflow({
        ...params,
        operatorApprovals: collectGrants(walk),
        toolPackagePins,
      });
    },
  };
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
}): Promise<void> {
  const now = new Date();
  await args.db.insert(intxSchema.agentInstance).values({
    id: deriveDeploymentAgentId(args.deploymentId),
    agentId: deriveDeploymentAgentId(args.deploymentId),
    tenantId: args.tenantId,
    principalId: args.creatorPrincipalId,
    address: deriveDeploymentAddress({
      deploymentId: args.deploymentId,
      deploymentDomain: args.deploymentDomain,
    }),
    status: "deployed" as const,
    createdAt: now,
    updatedAt: now,
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

export function toLaunchSession(
  sessionService: SessionService,
): LaunchSessionFn {
  return ({
    agentAddress,
    agentId,
    instanceId,
    config,
    deployContent,
    toolPackagePins,
  }) =>
    sessionService.launchSession({
      agentAddress,
      agentId,
      instanceId,
      config,
      // toolPackageManifest is intentionally not forwarded: tools resolve from
      // toolPackagePins through launchSession's own closure resolution, so the
      // orchestrator's manifest field (typed `unknown`) is never our source.
      deployContent: {
        systemPrompt: deployContent.systemPrompt,
        ...(deployContent.assetMounts
          ? { assetMounts: deployContent.assetMounts }
          : {}),
      },
      ...(toolPackagePins ? { toolPackagePins } : {}),
    });
}

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
