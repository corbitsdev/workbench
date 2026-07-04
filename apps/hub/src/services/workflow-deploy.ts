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
  type LaunchSessionFn,
  type SendMultiStepDeployFn,
  type WorkflowRepoWriter,
} from "@intx/workflow-deploy";
import type { DirectorRegistry } from "@intx/agent";
import { schema as intxSchema } from "@intx/db";
import { eq } from "drizzle-orm";
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
  type SessionService,
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
  // the deployment reconciler (CL-2224) and run-start/signal resilience
  // (CL-2225).
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
  sessionService: SessionService;
  directorRegistry: DirectorRegistry;
  // Optional: roll back a partial per-run deploy on failure. Absent in unit
  // tests that never exercise the failure path.
  reclaimDeployment?: ReclaimDeploymentFn;
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

  // TEMP-INSTRUMENTATION CL-2780: deployWorkflow writes its measured DB+grant
  // fan-out duration here so provisionRunDeployment can fold it into the
  // one-line provision summary. Read synchronously right after the awaited
  // deployWorkflow call resolves, so no interleave can clobber it.
  let lastDbFanoutMs = 0;

  const service: WorkflowDeployService = {
    deployWorkflow: async (params) => {
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
      //   deployed (reasoning with tools) — the full per-step provisioning: an
      //     `agent` row, an `agent_instance` row, a `state/grants.json`, and a
      //     launched session.
      //
      // `launchSession` is no-op'd below for both the inline and deterministic
      // sets — that, plus skipping their agent-state repos, is the
      // session-per-step RAM win.
      const inlineStepIds = collectInlineStepIds(params.workflow);
      const deterministicStepIds = collectDeterministicToolStepIds(
        params.workflow,
      );
      const allStepIds = [...walk.perStep.keys()];
      const deployedStepIds = allStepIds.filter(
        (stepId) =>
          !inlineStepIds.has(stepId) && !deterministicStepIds.has(stepId),
      );
      // Steps that keep an `agent` row: fully-deployed steps plus deterministic
      // tool steps (CL-2252 — the tool endpoints 404 without it).
      const agentRowStepIds = allStepIds.filter(
        (stepId) => !inlineStepIds.has(stepId),
      );
      const noLaunchAgentIds = new Set(
        [...inlineStepIds, ...deterministicStepIds].map((stepId) =>
          deriveStepAgentId({ deploymentId: params.deploymentId, stepId }),
        ),
      );

      // Persist an `agent` row per step that needs one (deployed + deterministic
      // tool). Interchange's launchSession never writes one, and the hub's
      // tool-credential + manifest gate authorizes a step by that row's pins —
      // every such step carries the same union pins the orchestrator hands it.
      // Inline steps are skipped: no harness, no row.
      const stepCapabilityNames = capabilityNames(walk);
      // TEMP-INSTRUMENTATION CL-2780
      const dbfanoutStart = performance.now();
      await writeStepAgentRows({
        db,
        deploymentId: params.deploymentId,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        stepIds: agentRowStepIds,
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

      // Persist a per-step `agent_instance` row before the orchestrator
      // launches each deployed step. Interchange's launch callbacks
      // deliberately do no DB writes — the native single-agent route creates
      // the instance row itself before `launchSession` (hub-api instances.ts),
      // and the `agent.deploy.ack` handler then resolves it via
      // `requireInstance` to store the step's public key. The orchestrator runs
      // the same launch path, so without this row every step deploy fails with
      // "No active instance found for address". Inline and deterministic-tool
      // steps never launch a session, so they get no instance row.
      await writeStepInstanceRows({
        db,
        deploymentId: params.deploymentId,
        deploymentDomain: params.deploymentDomain,
        tenantId: params.tenantId,
        creatorPrincipalId: params.creatorPrincipalId,
        stepIds: deployedStepIds,
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
        harnessSessionId: params.config.sessionId,
      });
      // TEMP-INSTRUMENTATION CL-2780
      const dbfanoutMs = performance.now() - dbfanoutStart;
      lastDbFanoutMs = dbfanoutMs;

      // TEMP-INSTRUMENTATION CL-2780: accumulate per-launch timing across the
      // deploy's launchSession calls (count/sum/max), wrapping the launch hook.
      const launchTiming = { count: 0, sum: 0, max: 0 };
      const timedLaunchSession: LaunchSessionFn = (launchParams) => {
        const launchStart = performance.now();
        const result = toLaunchSession(
          deps.sessionService,
          noLaunchAgentIds,
        )(launchParams);
        return result.finally(() => {
          const ms = performance.now() - launchStart;
          launchTiming.count += 1;
          launchTiming.sum += ms;
          if (ms > launchTiming.max) launchTiming.max = ms;
        });
      };

      // The orchestrator still walks every step (it pins each step's
      // InferenceSource into the supervisor frame's `sources` map, which the
      // sidecar's STEP_INFERENCE_SOURCES table reads — inline steps need that
      // entry too). It calls `launchSession` once per step; we wrap that hook so
      // an inline OR deterministic-tool step's agentId resolves to a no-op
      // promise WITHOUT touching the SessionService — zero agent-state repos,
      // zero session launches for either. Built per-deploy because the
      // no-launch agentId set depends on this workflow.
      const orchestrator = createWorkflowDeployOrchestrator({
        directorRegistry,
        workflowRepo: createWorkflowRepoWriter(deps.repoStore),
        // TEMP-INSTRUMENTATION CL-2780: timed wrapper around toLaunchSession.
        launchSession: timedLaunchSession,
        sendMultiStepDeploy: toSendMultiStepDeploy(deps.sidecarRouter),
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
      // TEMP-INSTRUMENTATION CL-2780
      log.info(
        "launchSession timing kind={kind}: launches={count} totalLaunchMs={sum} maxMs={max}",
        {
          kind: params.workflow.id,
          count: launchTiming.count,
          sum: Math.round(launchTiming.sum),
          max: Math.round(launchTiming.max),
        },
      );
      return deployResult;
    },

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
      // TEMP-INSTRUMENTATION CL-2780
      const provisionStart = performance.now();
      const defStart = performance.now();
      const definition = await readWorkflowDefinition(
        deps.repoStore,
        args.kind,
      );
      // TEMP-INSTRUMENTATION CL-2780
      const defMs = performance.now() - defStart;
      // TEMP-INSTRUMENTATION CL-2780
      const configStart = performance.now();
      const { deploymentId, config, deployContent } =
        await resolveWorkflowDeployConfig({
          db,
          tenantId: args.tenantId,
          principalId: args.creatorPrincipalId,
          deploymentDomain: args.deploymentDomain,
          definition,
        });
      // TEMP-INSTRUMENTATION CL-2780
      const configMs = performance.now() - configStart;
      // TEMP-INSTRUMENTATION CL-2780
      const deployStart = performance.now();
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
      // TEMP-INSTRUMENTATION CL-2780
      const deployMs = performance.now() - deployStart;
      // TEMP-INSTRUMENTATION CL-2780
      log.info(
        "provision timing kind={kind} steps={steps}: def={def}ms config={config}ms dbfanout={dbfanout}ms deployWorkflow={deployWorkflow}ms total={total}ms",
        {
          kind: args.kind,
          steps: definition.stepOrder.length,
          def: Math.round(defMs),
          config: Math.round(configMs),
          dbfanout: Math.round(lastDbFanoutMs),
          deployWorkflow: Math.round(deployMs),
          total: Math.round(performance.now() - provisionStart),
        },
      );
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
    sources: Record<string, InferenceSource>;
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
  const sources: Record<string, InferenceSource> = {};
  for (const stepId of args.definition.stepOrder) {
    sources[stepId] = pickFrameStepSource(
      args.definition.steps[stepId],
      args.sources,
      head,
    );
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
  // TEMP-INSTRUMENTATION CL-2780
  const grantLoopStart = performance.now();
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
  // TEMP-INSTRUMENTATION CL-2780
  log.info(
    "writeStepGrantFiles timing deploymentId={deploymentId}: steps={steps} writeTreeLoop={writeTreeLoop}ms",
    {
      deploymentId: args.deploymentId,
      steps: args.stepIds.length,
      writeTreeLoop: Math.round(performance.now() - grantLoopStart),
    },
  );
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

// Wrap the SessionService launch hook so a no-launch step's agentId resolves
// to a no-op resolved promise WITHOUT calling `launchSession`. The no-launch
// set is the inline-inference steps (CL-2251) plus the deterministic-tool steps
// (CL-2252): the orchestrator only awaits the promise, so never launching means
// zero per-step agent-state repos / sessions for either — the session-per-step
// RAM win. Fully-deployed reasoning steps launch unchanged.
export function toLaunchSession(
  sessionService: SessionService,
  noLaunchAgentIds: ReadonlySet<string> = new Set(),
): LaunchSessionFn {
  return (params) => {
    if (noLaunchAgentIds.has(params.agentId)) {
      return Promise.resolve();
    }
    return launchDeployedSession(sessionService, params);
  };
}

function launchDeployedSession(
  sessionService: SessionService,
  {
    agentAddress,
    agentId,
    instanceId,
    config,
    deployContent,
    toolPackagePins,
  }: Parameters<LaunchSessionFn>[0],
): ReturnType<LaunchSessionFn> {
  return sessionService.launchSession({
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
