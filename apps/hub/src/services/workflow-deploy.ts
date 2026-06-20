import {
  createWorkflowDeployOrchestrator,
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
