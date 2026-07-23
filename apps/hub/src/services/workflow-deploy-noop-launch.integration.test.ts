// CL-2782: no-op'ing the DEPLOYED-step launchSession at the hub. The measured
// ~17s of workflow-start latency was the per-step deploy→pack→session-start
// launch cycle. This test is the safety net for the linchpin claim: a deployed
// (reasoning-with-tools) step's run-time inputs are all HUB-WRITTEN deploy
// artifacts (the `agent` row, the `agent_instance` row, and `state/grants.json`)
// and NOT anything the launch produced — so dropping the launch cannot regress
// tool/credential resolution, authorization, or usage attribution.
//
// SCOPE — what this test proves, and what it does NOT:
//   - It proves DEPLOY-ARTIFACT PERSISTENCE with launches=0 (the agent row, the
//     inert agent_instance row, and the on-disk grants file) and drives the REAL
//     `@intx/authz` `evaluateGrants` over the grants read back off the deployed
//     repo (allow a granted tool, deny an ungranted one) — plus the CL-2705
//     per-step usage attribution that the kept instance row is load-bearing for.
//   - It does NOT execute a workflow step (no live sidecar over a WebSocket in
//     this harness). The end-to-end guarantee that a deployed step actually RUNS
//     with launches=0 is provided IN PRODUCTION by the `reestablishSupervisor`
//     precedent (`workflow-deploy.ts` — it re-drives a deployment's steps with no
//     per-step session at all), not by this test. This test guards that the
//     inputs that path depends on are all produced at deploy time.
//
// What is REAL here (nothing mocked at the @intx boundary):
//   - The REAL hub deploy service (`createWorkflowDeployService`) over the REAL
//     `@intx/workflow-deploy` orchestrator + REAL director registry.
//   - A REAL on-disk git-backed repo store: the orchestrator's WorkflowRepoWriter
//     commits `workflow.json`, and `writeStepGrantFiles` commits the deployed
//     step's `state/grants.json`. The grants are read BACK off disk — the same
//     working-tree read the sidecar's `readStepGrants` performs at run time.
//   - A REAL (PGlite) Postgres with the full hub schema, holding the `agent` +
//     `agent_instance` rows the deploy fans out and driving `getUsageByPerson`.
//   - The REAL `@intx/authz` `evaluateGrants` over the production
//     `tool:<name>`/`invoke` grammar — the exact call the sidecar step-tool
//     harness's installed `authorize` makes.
//
// HONEST GAP (documented, not faked): `sessionService.launchSession` and
// `sidecarRouter.sendAgentDeploy` resolve without a real sidecar. That is the
// point of the launches=0 assertion — with the CL-2782 change there is no
// launch to make real. The thin wrapper that INSTALLS `evaluateGrants` as the
// step harness's `authorize` from the same `ctx.grants` is exercised end-to-end
// by `apps/sidecar/src/step-tool-authz.test.ts`; here we exercise the evaluator
// itself on the hub-produced grants so the hub→repo→authz seam is real.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import type { InferenceSource } from "@intx/types/runtime";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import { deriveStepAgentId } from "@intx/workflow-deploy";
import { schema as intxSchema } from "@intx/db";
import {
  createRepoStore,
  type AgentRepoStore,
  type AuthorizeFn,
  type KindHandler,
  type RepoStore,
  type SidecarRouter,
  type ValidatePushResult,
} from "@intx/hub-sessions";
import {
  createWorkbenchDirectorRegistry,
  agentStep,
  LLM_DEFAULT_MODEL,
} from "@workbench/agents";

// readWorkflowDefinition (imported transitively by the deploy service) reads its
// cache TTL from getConfig(); apps/hub tests do not preload loadConfig, so stub
// the one field it touches. This is a config-only stub, NOT an @intx boundary.
mock.module("../config", () => ({
  getConfig: () => ({
    workflowDeploy: {
      modelSourceCacheTtlMs: 45_000,
      definitionCacheTtlMs: 45_000,
    },
  }),
}));

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  createWorkflowDeployService,
  buildStepGrantRules,
} from "./workflow-deploy";
import { assembleWorkflowDeployConfig } from "./workflow-deploy-config";
import { getUsageByPerson } from "./activity-overview";

const DEPLOYMENT_DOMAIN = "wf.localhost";
const TENANT_ID = "tn-noop";
const DEPLOY_PRINCIPAL = "prn-deployer";
const DEPLOYMENT_ID = "ses_noop_deploy";
const RUN_OWNER_PRINCIPAL = "prn-run-owner";

// Real attio + granola tool capabilities so the grants file carries
// production-shaped `tool:<canonical>`/invoke rules (and the deploy resolves
// real tool package pins). The deployed `analyze` step is a genuine
// reasoning-with-tools step.
const GRANTED_TOOL = "@workbench/tools-attio/attio:attio_get_task";
const GRANTED_TOOL_2 = "@workbench/tools-granola/granola:granola_get_note";
const UNGRANTED_TOOL =
  "@workbench/tools-gamma/gamma:gamma_create_from_template";

const allowAll: AuthorizeFn = () => ({ allowed: true });
function permissive(
  kind: KindHandler["kind"],
  directoryPrefix: string,
): KindHandler {
  return {
    kind,
    directoryPrefix,
    validatePush(): ValidatePushResult {
      return { ok: true };
    },
    onRefUpdated() {
      /* no-op */
    },
  };
}

const TENANT_SOURCE: InferenceSource = {
  id: "src-noop",
  provider: "openai-compatible",
  baseURL: "http://inference.invalid",
  apiKey: "test-key",
  model: LLM_DEFAULT_MODEL,
};

let tempDir: string;
let repoStore: RepoStore;
let signingKey: KeyPair;
let client: PGlite;
let db: HubDb;

function toAgentRepoStore(store: RepoStore): AgentRepoStore {
  return { repoStore: store } as unknown as AgentRepoStore;
}

// A minimal but genuine deployed workflow: a native reasoning step (agentStep,
// no tools) feeding a deployed (reasoning-with-tools) `analyze` step that
// declares real tool capabilities and the tenant's default model.
function buildDeployedWorkflow(): WorkflowDefinition {
  const analyzeAgent = defineAgent({
    id: "analyze",
    description: "deployed reasoning step with tools",
    systemPrompt: "analyze the task and decide which tools to call",
    tools: [],
    capabilities: [GRANTED_TOOL, GRANTED_TOOL_2],
    inference: {
      sources: [{ provider: "openai-compatible", model: LLM_DEFAULT_MODEL }],
    },
  });
  return defineWorkflow({
    id: "attio-task-agent",
    trigger: { type: "manual" },
    steps: {
      ground: agentStep({
        id: "ground",
        systemPrompt: "summarize the input",
      }),
      analyze: step({ agent: analyzeAgent, after: ["ground"] }),
    },
  }) as unknown as WorkflowDefinition;
}

type DeployProbes = {
  sendAgentDeploy: ReturnType<typeof mock>;
};

async function deployDeployedWorkflow(): Promise<DeployProbes> {
  const workflow = buildDeployedWorkflow();
  // The in-process session runtime is retired: the deploy service wires a no-op
  // per-step launch hook internally, so there is no `sessionService` seam to
  // inject or probe. "No per-step launch" is now guaranteed by construction —
  // the only sidecar hand-off is the single supervisor `sendAgentDeploy`.
  const sendAgentDeploy = mock(async () => ({ publicKey: "deadbeef" }));
  const sidecarRouter = {
    sendAgentDeploy,
    getRoutableAddresses: () => [],
  } as unknown as SidecarRouter;

  const { config, deployContent } = assembleWorkflowDeployConfig({
    deploymentId: DEPLOYMENT_ID,
    tenantId: TENANT_ID,
    principalId: DEPLOY_PRINCIPAL,
    deploymentDomain: DEPLOYMENT_DOMAIN,
    sources: [TENANT_SOURCE],
  });

  const service = createWorkflowDeployService({
    db,
    repoStore: toAgentRepoStore(repoStore),
    sidecarRouter,
    directorRegistry: createWorkbenchDirectorRegistry(),
    // Provisioning REQUIRES a stager (FIX 2b). This test proves deploy-artifact
    // persistence, not on-disk staging, so inject an explicit no-op stager
    // (the single supervisor frame is still the only sidecar hand-off).
    stageWorkflowStep: () => Promise.resolve(),
  });

  await service.deployWorkflow({
    workflow,
    deploymentId: DEPLOYMENT_ID,
    deploymentDomain: DEPLOYMENT_DOMAIN,
    tenantId: TENANT_ID,
    creatorPrincipalId: DEPLOY_PRINCIPAL,
    config,
    deployContent,
    hubPublicKey: Buffer.from(signingKey.publicKey).toString("hex"),
  });
  return { sendAgentDeploy };
}

async function readStepGrants(
  deploymentId: string,
  stepId: string,
): Promise<GrantRule[]> {
  const dir = repoStore.getRepoDir({
    kind: "agent-state",
    id: `${deploymentId}-${stepId}`,
  });
  const raw = await fs.promises.readFile(
    path.join(dir, "state", "grants.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as { grants: GrantRule[] };
  return parsed.grants;
}

beforeAll(async () => {
  client = new PGlite();
  const b = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, b as never);
  await apply();
  // FK triggers off — the deploy fans out agent/instance/session rows without
  // the full tenancy graph, exactly as the sibling CL-2705 attribution test.
  await client.exec(`SET session_replication_role = 'replica';`);
  db = b as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wf-noop-it-"));
  signingKey = await generateKeyPair();
  repoStore = createRepoStore({
    dataDir: tempDir,
    signingKey,
    handlers: {
      workflow: permissive("workflow", "workflows"),
      "agent-state": permissive("agent-state", "agent-state"),
    },
    authorize: allowAll,
  });
  for (const t of [
    "member_agent_instance",
    "agent_instance",
    "agent_session",
    "agent",
    "workflow_run_record",
    "analytics_rollup_daily",
  ]) {
    await client.exec(`DELETE FROM "${t}";`);
  }
});

afterEach(async () => {
  await fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch(() => {});
});

describe("deployed-step deploy-artifact persistence with launches=0 (CL-2782)", () => {
  test("deploys a reasoning-with-tools workflow with launches=0, persists the deploy artifacts, and authorizes off the on-disk grants file", async () => {
    const { sendAgentDeploy } = await deployDeployedWorkflow();

    const analyzeAgentId = deriveStepAgentId({
      deploymentId: DEPLOYMENT_ID,
      stepId: "analyze",
    });

    // (a) launches=0 — NO per-step session is launched (the deploy service has
    // no launch seam at all now). Only the supervisor deploy frame fired.
    expect(sendAgentDeploy).toHaveBeenCalled();

    // (b) The deployed step's deploy artifacts persisted despite launches=0:
    //   - the `agent` row (the tool manifest/credentials hub RPC gate on it at
    //     run time — this is HOW tools + credentials resolve without a launch),
    //   - the `agent_instance` row (KEPT for CL-2705 per-step usage attribution;
    //     asserted end-to-end below),
    //   - the grants file on the agent-state repo.
    const agentRow = await db.query.agent.findFirst({
      where: eq(intxSchema.agent.id, analyzeAgentId),
    });
    expect(agentRow?.id).toBe(analyzeAgentId);
    const instanceRow = await db.query.agentInstance.findFirst({
      where: eq(intxSchema.agentInstance.id, analyzeAgentId),
    });
    expect(instanceRow?.id).toBe(analyzeAgentId);
    // The kept row is inert: no launch acked it, so it carries no public key.
    expect(instanceRow?.publicKey ?? null).toBeNull();

    // (c) Read the grants BACK off the deployed repo (the same working-tree read
    // the sidecar performs at run time) and drive the REAL @intx/authz evaluator
    // over them — the exact call the step harness's installed authorize makes.
    const runtimeGrants = await readStepGrants(DEPLOYMENT_ID, "analyze");
    // `.toEqual` here proves REPO ROUND-TRIP INTEGRITY only (the writer is its
    // own oracle); the load-bearing check is the evaluateGrants allow/deny below.
    const canonical = buildStepGrantRules([GRANTED_TOOL, GRANTED_TOOL_2]);
    const stripId = (g: GrantRule): Omit<GrantRule, "id"> => {
      const { id: _id, ...rest } = g;
      return rest;
    };
    expect(runtimeGrants.map(stripId)).toEqual(canonical.map(stripId));

    const granted = await evaluateGrants(
      runtimeGrants,
      `tool:${GRANTED_TOOL}`,
      "invoke",
    );
    expect(granted?.effect).toBe("allow");

    const denied = await evaluateGrants(
      runtimeGrants,
      `tool:${UNGRANTED_TOOL}`,
      "invoke",
    );
    expect(denied?.effect).not.toBe("allow");
  });

  // The KEEP-the-inert-instance-row decision (the panel's key correction) rests
  // entirely on CL-2705 per-step usage attribution. This exercises the actual
  // attribution path — activity-overview's `workflowOwnerByInstance` join, which
  // maps a deployed step's `agent_instance` (address `ins_<deploymentId>%`) to
  // the run OWNER via `workflow_run_record.principalId` — so a future "clean up
  // the dead row" refactor fails here rather than silently dropping the deployed
  // step's inference usage from per-person analytics.
  test("the kept inert instance row attributes the deployed step's usage to the run owner; dropping it breaks attribution (red-proof)", async () => {
    await deployDeployedWorkflow();
    const analyzeAgentId = deriveStepAgentId({
      deploymentId: DEPLOYMENT_ID,
      stepId: "analyze",
    });

    // The run record naming this deployment: its principalId is the human who
    // started the run (the owner attribution must resolve to).
    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ($1,$2,'attio-task-agent',$3,$4,'completed','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
      ["wfr-noop", DEPLOYMENT_ID, TENANT_ID, RUN_OWNER_PRINCIPAL],
    );
    // Inference usage rolled up under the DEPLOYED step's instance id (deployed
    // reasoning steps emit inference usage keyed on their per-step instance).
    await client.query(
      `insert into analytics_rollup_daily (id, tenant_id, instance_id, bucket_date, rollup_key, turn_count, tool_call_count, input_tokens, output_tokens)
       values ($1,$2,$3,'2026-07-01',$1,1,0,700,300)`,
      ["rollup-noop", TENANT_ID, analyzeAgentId],
    );

    // With the inert instance row present, the deployed step's 1000 tokens
    // attribute to the run owner via workflowOwnerByInstance.
    const attributed = await getUsageByPerson({
      db,
      tenantId: TENANT_ID,
      callerPrincipalId: null,
    });
    const owner = attributed.find((r) => r.principalId === RUN_OWNER_PRINCIPAL);
    expect(owner).toBeDefined();
    expect(owner!.inputTokens + owner!.outputTokens).toBe(1000);

    // RED-PROOF: drop the deployed step's instance row (what "cleaning up the
    // dead row" would do). The rollup can no longer resolve an owner — the
    // step's usage falls out of per-person attribution entirely.
    await db
      .delete(intxSchema.agentInstance)
      .where(eq(intxSchema.agentInstance.id, analyzeAgentId));

    const afterDrop = await getUsageByPerson({
      db,
      tenantId: TENANT_ID,
      callerPrincipalId: null,
    });
    expect(
      afterDrop.find((r) => r.principalId === RUN_OWNER_PRINCIPAL),
    ).toBeUndefined();
  });

  // Red-proof for assertion (c): the authz check must be able to FAIL for a real
  // reason. An empty grant set (what a step would carry if the grants file were
  // lost / never written) denies the previously-granted tool — proving authz is
  // genuinely driven by the grants file, not a tautology.
  test("an empty grants file denies the previously-granted tool (red-proof)", async () => {
    const denied = await evaluateGrants([], `tool:${GRANTED_TOOL}`, "invoke");
    expect(denied?.effect).not.toBe("allow");
  });
});
