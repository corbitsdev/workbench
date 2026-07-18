import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type } from "arktype";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import type { InferenceSource } from "@intx/types/runtime";
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
  LLM_DEFAULT_MODEL,
} from "@workbench/agents";

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";

// readWorkflowDefinition reads its cache TTL from getConfig(); apps/hub tests do
// not preload test-setup/loadConfig, so stub the one field it touches.
mock.module("../config", () => ({
  getConfig: () => ({
    workflowDeploy: {
      modelSourceCacheTtlMs: 45_000,
      definitionCacheTtlMs: 45_000,
    },
  }),
}));

import {
  createWorkflowDeployService,
  readWorkflowDefinition,
} from "./workflow-deploy";
import { assembleWorkflowDeployConfig } from "./workflow-deploy-config";
import { createWorkflowReconciler } from "./workflow-reconciler";
import {
  definitionFingerprint,
  embeddedWorkflowDefsDir,
  EmbeddedWorkflowDefSchema,
} from "../lib/workflow-defs-embedded";
import type { WorkflowDefinition } from "@intx/workflow";

// CL-2713: the workflow deploy → run-index → restart-reconcile seam that keeps
// regressing to prod, exercised over REAL components (a real on-disk git-backed
// repo store, the REAL @intx/workflow-deploy orchestrator + hub deploy service,
// the REAL readWorkflowDefinition envelope round-trip, and a real (PGlite)
// Postgres for the reconciler's index queries + status writes). Nothing at the
// @intx boundary is mocked.
//
// HONEST GAPS (documented, not faked — a live sidecar over a WebSocket driving
// the workflow-host supervisor is genuinely infeasible in this harness):
//   - The sidecar frame hand-off is stubbed: `sessionService.launchSession` and
//     `sidecarRouter.sendAgentDeploy` resolve without a sidecar. This does NOT
//     touch what gets persisted to the `workflow` repo — the orchestrator's
//     `WorkflowRepoWriter` commits `workflow.json` independently — so the
//     fingerprint-readback seam (the CL-2593 drift condition that
//     workflow-defs-bootstrap.ts only LOGS today) is fully real here.
//   - Coverage steps 2 and 4 (a run actually reaching an `awaitSignal` gate and
//     resuming to `completed` with a materialized artifact) need the live
//     workflow-host over a real IPC/WS loop; that path is exercised by
//     `packages/workflow-host/.../live-signal-watcher-restart.integration.test.ts`.
//     Here the `awaiting`/`running` states a restart consumes are seeded as the
//     `workflow_run_record` index rows the hub control plane actually reads, and
//     the reconciler's re-establish call is asserted at its injected seam
//     (`ensureDeploymentRoutable`) — the sidecar send inside it is the same
//     stubbed hand-off.

const HUB_PRINCIPAL = { kind: "hub" as const };
const DEPLOYMENT_DOMAIN = "wf.localhost";
const TENANT_ID = "tn-gate";
const DEPLOY_PRINCIPAL = "prn-deployer";

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

// Minimal DDL for the three intx tables the deploy service inserts into
// (foreign keys omitted — the fingerprint seam under test needs the rows to
// persist, not the full tenancy graph) plus the two workbench run-index tables
// the reconciler queries. Mirrors the hand-written-DDL pattern of the sibling
// integration tests (projection-bridge / workflow-run-facts).
// Full column set from the intx schema (drizzle's INSERT names every column,
// filling unprovided ones with DEFAULT), minus foreign keys.
const AGENT_DDL = `
  CREATE TABLE agent (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    creator_principal_id text NOT NULL,
    name text NOT NULL,
    description text,
    system_prompt text,
    context_config jsonb,
    initial_state jsonb,
    model_config jsonb,
    capabilities jsonb,
    credential_requirements jsonb,
    model_requirements jsonb,
    tool_packages jsonb NOT NULL DEFAULT '[]'::jsonb,
    grant_requirements jsonb,
    current_version text NOT NULL DEFAULT '1',
    status text NOT NULL DEFAULT 'deployed',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
`;
const AGENT_INSTANCE_DDL = `
  CREATE TABLE agent_instance (
    id text PRIMARY KEY,
    agent_id text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    address text NOT NULL UNIQUE,
    version_id text,
    session_id text,
    status text NOT NULL DEFAULT 'deployed',
    sidecar_id text,
    public_key text,
    kernel_id text,
    model_preferences jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    ended_at timestamp
  );
`;
const AGENT_SESSION_DDL = `
  CREATE TABLE agent_session (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    ended_at timestamp
  );
`;
const WORKFLOW_RUN_DDL = `
  CREATE TABLE workflow_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id text,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    input jsonb,
    output jsonb,
    meta jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;
const WORKFLOW_RUN_RECORD_DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    origin_conversation_id text,
    trigger_source text,
    pending_signal jsonb,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

// A tenant catalog inference source, shaped like the one resolveModelSources
// returns, so assembleWorkflowDeployConfig (the real hub config builder) can
// pin it and the capability-approval gate self-approves the emit step's source.
const TENANT_SOURCE: InferenceSource = {
  id: "src-gate",
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

// Load the build-committed embedded def the way loadEmbeddedDefs does — parsed
// through the same envelope schema the deploy route validates request bodies
// with — so the fingerprint compares like-for-like against production input.
function loadEmbedded(kind: string): typeof EmbeddedWorkflowDefSchema.infer {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(embeddedWorkflowDefsDir(), `${kind}.json`),
      "utf8",
    ),
  );
  const parsed = EmbeddedWorkflowDefSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `embedded def ${kind} failed schema parse: ${parsed.summary}`,
    );
  }
  return parsed;
}

// Deploy an embedded def through the REAL hub deploy service (real orchestrator
// + real WorkflowRepoWriter into the real repo store; only the sidecar send is
// stubbed). Returns the embedded def whose fingerprint the caller compares to
// the read-back one.
async function deployEmbedded(
  kind: string,
): Promise<typeof EmbeddedWorkflowDefSchema.infer> {
  const embedded = loadEmbedded(kind);
  const deploymentId = "ses_gate_deploy";

  const sendAgentDeploy = mock(() =>
    Promise.resolve({ publicKey: "deadbeef" }),
  );
  const sidecarRouter = {
    sendAgentDeploy,
    getRoutableAddresses: () => [],
  } as unknown as SidecarRouter;

  const { config, deployContent } = assembleWorkflowDeployConfig({
    deploymentId,
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
    // Provisioning REQUIRES a stager (FIX 2b); this test stages no real tool
    // tree, so inject an explicit no-op rather than relying on a silent
    // fallback.
    stageWorkflowStep: () => Promise.resolve(),
  });

  await service.deployWorkflow({
    workflow: embedded.definition as unknown as WorkflowDefinition,
    deploymentId,
    deploymentDomain: DEPLOYMENT_DOMAIN,
    tenantId: TENANT_ID,
    creatorPrincipalId: DEPLOY_PRINCIPAL,
    config,
    deployContent,
    hubPublicKey: Buffer.from(signingKey.publicKey).toString("hex"),
  });

  // The orchestrator must have committed the definition to the workflow repo
  // and dispatched the supervisor frame — the real deploy path ran end to end.
  expect(sendAgentDeploy).toHaveBeenCalled();
  return embedded;
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wf-gate-it-"));
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

  client = new PGlite();
  await client.exec(AGENT_DDL);
  await client.exec(AGENT_INSTANCE_DDL);
  await client.exec(AGENT_SESSION_DDL);
  await client.exec(WORKFLOW_RUN_DDL);
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
  await fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch(() => {});
});

describe("workflow regression gate (CL-2713)", () => {
  // Coverage step 1: the flagship assertion. The bootstrap idempotency check
  // (workflow-defs-bootstrap.ts ~L218) relies on deployWorkflow persisting the
  // definition such that the read-back fingerprint equals the embedded one; a
  // drift there silently republishes every boot (the "stale def" prod symptom)
  // and today is only LOGGED. This asserts the equality over the real deploy +
  // read-back path.
  test("deploy → read-back fingerprint equals the embedded def's fingerprint", async () => {
    const embedded = await deployEmbedded("smoke-test");

    const readBack = await readWorkflowDefinition(
      toAgentRepoStore(repoStore),
      "smoke-test",
    );

    expect(definitionFingerprint(readBack)).toBe(
      definitionFingerprint(embedded.definition),
    );
  });

  // Red-proof for the assertion above: if the persisted def drifts from the
  // embedded one, the fingerprint equality MUST break. Overwrite the committed
  // workflow.json with a mutated definition and confirm the read-back
  // fingerprint no longer matches — proving the flagship assertion can fail for
  // a real reason (it is not a tautology).
  test("fingerprint assertion goes red when the persisted def drifts", async () => {
    const embedded = await deployEmbedded("smoke-test");

    // Deep-clone the embedded def and mutate a nested field — the exact shape of
    // a serialization/round-trip drift the fingerprint must catch.
    const drifted = JSON.parse(JSON.stringify(embedded.definition)) as {
      steps: Record<string, { agent?: { systemPrompt?: string } }>;
    };
    const emitStep = drifted.steps.emit;
    if (emitStep?.agent === undefined) {
      throw new Error("smoke-test emit step lost its agent — fixture drifted");
    }
    emitStep.agent.systemPrompt = "DRIFTED PROMPT — not what was embedded";
    await repoStore.writeTree(
      HUB_PRINCIPAL,
      { kind: "workflow", id: "smoke-test" },
      "refs/heads/main",
      {
        files: { "workflow.json": JSON.stringify(drifted) },
        message: "simulate persisted-def drift",
      },
    );

    const readBack = await readWorkflowDefinition(
      toAgentRepoStore(repoStore),
      "smoke-test",
    );
    expect(definitionFingerprint(readBack)).not.toBe(
      definitionFingerprint(embedded.definition),
    );
  });

  // Coverage step 3a (CL-2575): a run parked at an awaitSignal gate (`awaiting`)
  // survives a sidecar restart — failOrphanedRuns must NOT flip it terminal,
  // while a genuinely-interrupted `running` run with no routable supervisor IS
  // failed. Real reconciler + real setRunStatus + real (PGlite) index rows; the
  // routable snapshot is empty, simulating the restart that dropped every
  // supervisor.
  test("failOrphanedRuns preserves an awaiting run and fails an interrupted running run", async () => {
    await seedRunRecord("wfr-parked", "ses_parked", "awaiting");
    await seedRunRecord("wfr-interrupted", "ses_interrupted", "running");

    const reconciler = createWorkflowReconciler({
      db,
      events: { on: () => () => {} } as unknown as SidecarRouter["events"],
      ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
    });

    await reconciler.failOrphanedRuns();

    expect(await runStatus("wfr-parked")).toBe("awaiting");
    expect(await runStatus("wfr-interrupted")).toBe("failed");
  });

  // Coverage step 3b: after the restart, reconcileAll re-establishes the
  // supervisor for the still-parked run — recovering the DEPLOY principal from
  // the kind's `workflow_run` registry row (the run record carries the run
  // OWNER, not the deployer) and calling ensureDeploymentRoutable for the parked
  // deployment. The failed/interrupted run is terminal and must NOT be
  // re-established. Asserts the reconciler's real walk at its injected seam; the
  // sidecar send inside ensureDeploymentRoutable is the stubbed hand-off.
  test("reconcileAll re-establishes only the parked run's supervisor with the deploy principal", async () => {
    await seedRunRecord("wfr-parked", "ses_parked", "awaiting", "brief");
    await seedRunRecord("wfr-done", "ses_done", "completed", "brief");
    // Registry row supplies the deploy principal for kind `brief` in this tenant.
    await db.insert(workflowRun).values({
      deploymentId: "ses_registry",
      tenantId: TENANT_ID,
      principalId: DEPLOY_PRINCIPAL,
      kind: "brief",
      status: "deployed",
    });

    const calls: {
      deploymentId: string;
      kind: string;
      tenantId: string;
      creatorPrincipalId: string;
    }[] = [];
    const reconciler = createWorkflowReconciler({
      db,
      events: { on: () => () => {} } as unknown as SidecarRouter["events"],
      ensureDeploymentRoutable: (args) => {
        calls.push(args);
        return Promise.resolve({ reestablished: true });
      },
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      reclaimDeployment: () => Promise.resolve(),
      sendAgentUndeploy: () => Promise.resolve(),
      sendSignalDeliver: () => {},
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual([
      {
        deploymentId: "ses_parked",
        kind: "brief",
        tenantId: TENANT_ID,
        creatorPrincipalId: DEPLOY_PRINCIPAL,
      },
    ]);
  });
});

async function seedRunRecord(
  runId: string,
  deploymentId: string,
  status: string,
  kind = "smoke-test",
): Promise<void> {
  await db.insert(workflowRunRecord).values({
    id: runId,
    deploymentId,
    kind,
    tenantId: TENANT_ID,
    principalId: "prn-owner",
    status: status as never,
  });
}

async function runStatus(runId: string): Promise<string> {
  const rows = await client.query<{ status: string }>(
    "SELECT status FROM workflow_run_record WHERE id = $1",
    [runId],
  );
  return rows.rows[0]?.status ?? "MISSING";
}
