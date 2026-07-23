import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import {
  createRepoStore,
  type AgentRepoStore,
  type AuthorizeFn,
  type KindHandler,
  type Principal,
  type RepoId,
  type RepoStore,
  type ValidatePushResult,
} from "@workbench/hub-sessions";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import { deterministicToolStep } from "@workbench/agents";
import {
  getWorkflowAnalytics,
  getWorkflowRunBreakdown,
} from "@workbench/analytics";

// readWorkflowDefinition (reached via the fact projector) reads its cache TTL
// from getConfig(); apps/hub tests do not preload test-setup/loadConfig, so stub
// the one field it touches.
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
  projectWorkflowRunFacts,
  reprojectWorkflowFacts,
} from "./workflow-run-facts";
import { deriveWorkflowRunRepoId } from "../routes/workflow-runs";

// Integration coverage for the CL-2670 fact projector across its REAL seams: a
// real on-disk workflow-run repo (committed native event blobs), the real
// @intx/workflow state-machine fold (via getWorkflowRunStateForRepo), the real
// step-kind classification from a deployed definition, and a real (PGlite)
// Postgres write of the derived facts. Nothing at the @intx boundary is mocked.

const RUN_EVENT_REF = "refs/heads/main";
const HUB_PRINCIPAL: Principal = { kind: "hub" };
const DEPLOYMENT_ID = "dep-facts";
const DEPLOYMENT_DOMAIN = "wf.localhost";
const KIND = "brief";
const TENANT_ID = "tn-facts";
const RUN_ID = "wfr-facts";

const REPO_ID: RepoId = {
  kind: "workflow-run",
  id: deriveWorkflowRunRepoId({
    deploymentId: DEPLOYMENT_ID,
    deploymentDomain: DEPLOYMENT_DOMAIN,
  }),
};
const DEF_REPO_ID: RepoId = { kind: "workflow", id: KIND };

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

const scoreAgent = defineAgent({
  id: "score-agent",
  description: "A genuine reasoning agent",
  systemPrompt: "Score it.",
  tools: [],
  capabilities: [],
  inference: { sources: [] },
});

// A three-step workflow: a deterministic fetch (retried), a human gate, and a
// reasoning agent step — so the projected step facts carry a real stepKind for
// each classification.
const DEFINITION = defineWorkflow({
  id: KIND,
  triggers: [{ type: "manual" }],
  steps: {
    fetch: deterministicToolStep({ id: "fetch-agent", tool: "fetch_tool" }),
    approve: awaitSignal({ name: "approval" }),
    score: step({ agent: scoreAgent }),
  },
});

const t = (n: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

// A valid native run log: fetch fails then succeeds on retry (attempt 2), the
// approve gate is awaited and received (a 2s gate wait) then completes, and score
// fails with retries exhausted, failing the run.
function buildEventLog(runId: string): Record<string, unknown>[] {
  return [
    {
      seq: 1,
      type: "RunStarted",
      runId,
      at: t(1),
      definitionHash: "h",
      trigger: { type: "manual", payload: {} },
    },
    {
      seq: 2,
      type: "StepStarted",
      stepId: "fetch",
      at: t(2),
      attempt: 1,
      input: { ref: "r0" },
    },
    {
      seq: 3,
      type: "StepFailed",
      stepId: "fetch",
      at: t(3),
      attempt: 1,
      error: { message: "transient" },
      retriesExhausted: false,
    },
    {
      seq: 4,
      type: "TimerSet",
      timerId: "tmr-1",
      at: t(4),
      fireAt: t(5),
      stepId: "fetch",
    },
    {
      seq: 5,
      type: "AttemptScheduled",
      stepId: "fetch",
      at: t(5),
      nextAttempt: 2,
      timerId: "tmr-1",
      fireAt: t(5),
    },
    { seq: 6, type: "TimerFired", timerId: "tmr-1", at: t(6) },
    {
      seq: 7,
      type: "StepCompleted",
      stepId: "fetch",
      at: t(7),
      attempt: 2,
      output: { ref: "r-fetch" },
    },
    {
      seq: 8,
      type: "StepStarted",
      stepId: "approve",
      at: t(8),
      attempt: 1,
      input: { ref: "r-fetch" },
    },
    {
      seq: 9,
      type: "SignalAwaited",
      stepId: "approve",
      at: t(9),
      signalName: "approval",
    },
    {
      seq: 10,
      type: "SignalReceived",
      at: t(11),
      signalName: "approval",
      signalId: "sig-1",
      payload: {},
    },
    {
      seq: 11,
      type: "StepCompleted",
      stepId: "approve",
      at: t(12),
      attempt: 1,
      output: { ref: "r-approve" },
    },
    {
      seq: 12,
      type: "StepStarted",
      stepId: "score",
      at: t(13),
      attempt: 1,
      input: { ref: "r-fetch" },
    },
    {
      seq: 13,
      type: "StepFailed",
      stepId: "score",
      at: t(14),
      attempt: 1,
      error: { message: "scorer exploded" },
      retriesExhausted: true,
    },
    {
      seq: 14,
      type: "RunFailed",
      at: t(15),
      error: { message: "one or more steps failed" },
    },
  ];
}

const RUN_FACT_DDL = `
  CREATE TABLE workflow_run_fact (
    run_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    outcome text NOT NULL,
    started_at timestamptz,
    ended_at timestamptz,
    duration_ms bigint,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;
const STEP_FACT_DDL = `
  CREATE TABLE workflow_step_fact (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    step_id text NOT NULL,
    attempt integer NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    step_kind text NOT NULL,
    outcome text NOT NULL,
    started_at timestamptz,
    ended_at timestamptz,
    duration_ms bigint,
    gate_wait_ms bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, step_id, attempt)
  );
`;
const RUN_RECORD_DDL = `
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

let tempDir: string;
let repoStore: RepoStore;
let agentRepoStore: AgentRepoStore;
let signingKey: KeyPair;
let client: PGlite;
let db: HubDb;

function toAgentRepoStore(store: RepoStore): AgentRepoStore {
  return { repoStore: store } as unknown as AgentRepoStore;
}

async function commitRunLog(runId: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const event of buildEventLog(runId)) {
    files[`runs/${runId}/events/${String(event["seq"])}.json`] =
      JSON.stringify(event);
  }
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files,
    message: `run log ${runId}`,
  });
}

async function deployDefinition(): Promise<void> {
  await repoStore.writeTree(HUB_PRINCIPAL, DEF_REPO_ID, RUN_EVENT_REF, {
    files: { "workflow.json": JSON.stringify(DEFINITION) },
    message: "definition",
  });
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wf-facts-it-"));
  signingKey = await generateKeyPair();
  repoStore = createRepoStore({
    dataDir: tempDir,
    signingKey,
    handlers: {
      "workflow-run": permissive("workflow-run", "workflow-runs"),
      workflow: permissive("workflow", "workflows"),
    },
    authorize: allowAll,
  });
  agentRepoStore = toAgentRepoStore(repoStore);
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files: { ".gitignore": "" },
    message: "genesis",
  });
  await deployDefinition();

  client = new PGlite();
  await client.exec(RUN_FACT_DDL);
  await client.exec(STEP_FACT_DDL);
  await client.exec(RUN_RECORD_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
  await fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch(() => {});
});

describe("projectWorkflowRunFacts — log -> derived facts", () => {
  test("projects run + step facts with duration, gate-wait, kind, and outcome", async () => {
    await commitRunLog(RUN_ID);
    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      { repoId: REPO_ID, runId: RUN_ID, kind: KIND, tenantId: TENANT_ID },
    );

    const breakdown = await getWorkflowRunBreakdown({
      db,
      tenantId: TENANT_ID,
      runId: RUN_ID,
    });
    expect(breakdown).not.toBeNull();
    expect(breakdown?.outcome).toBe("failed");
    expect(breakdown?.durationMs).toBe(14_000);

    const byId = new Map((breakdown?.steps ?? []).map((s) => [s.stepId, s]));
    expect(byId.get("fetch")).toMatchObject({
      stepKind: "deterministic",
      outcome: "completed",
      attempt: 2,
      durationMs: 5_000,
      gateWaitMs: null,
    });
    expect(byId.get("approve")).toMatchObject({
      stepKind: "human",
      outcome: "completed",
      durationMs: 4_000,
      gateWaitMs: 2_000,
    });
    expect(byId.get("score")).toMatchObject({
      stepKind: "agent",
      outcome: "failed",
      durationMs: 1_000,
    });
  });

  test("re-projecting a run is idempotent — its facts are replaced, not duplicated", async () => {
    await commitRunLog(RUN_ID);
    const opts = {
      repoId: REPO_ID,
      runId: RUN_ID,
      kind: KIND,
      tenantId: TENANT_ID,
    };
    await projectWorkflowRunFacts({ db, repoStore: agentRepoStore }, opts);
    await projectWorkflowRunFacts({ db, repoStore: agentRepoStore }, opts);

    const runRows = await db
      .select()
      .from(schema.workflowRunFact)
      .where(eq(schema.workflowRunFact.runId, RUN_ID));
    const stepRows = await db
      .select()
      .from(schema.workflowStepFact)
      .where(eq(schema.workflowStepFact.runId, RUN_ID));
    expect(runRows.length).toBe(1);
    expect(stepRows.length).toBe(3);
  });
});

describe("getWorkflowAnalytics — aggregate over terminal runs", () => {
  test("aggregates counts, success rate, and duration percentiles by kind + step kind", async () => {
    // Two runs of KIND: run A fails (score fails), run B is all-completed.
    await commitRunLog("wfr-a");
    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      { repoId: REPO_ID, runId: "wfr-a", kind: KIND, tenantId: TENANT_ID },
    );

    // Run B: a clean completion of just the fetch step, faster.
    await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
      files: {
        "runs/wfr-b/events/1.json": JSON.stringify({
          seq: 1,
          type: "RunStarted",
          runId: "wfr-b",
          at: t(20),
          definitionHash: "h",
          trigger: { type: "manual", payload: {} },
        }),
        "runs/wfr-b/events/2.json": JSON.stringify({
          seq: 2,
          type: "StepStarted",
          stepId: "fetch",
          at: t(21),
          attempt: 1,
          input: { ref: "r0" },
        }),
        "runs/wfr-b/events/3.json": JSON.stringify({
          seq: 3,
          type: "StepCompleted",
          stepId: "fetch",
          at: t(22),
          attempt: 1,
          output: { ref: "r-fetch" },
        }),
        "runs/wfr-b/events/4.json": JSON.stringify({
          seq: 4,
          type: "RunCompleted",
          at: t(23),
        }),
      },
      message: "run b",
    });
    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      { repoId: REPO_ID, runId: "wfr-b", kind: KIND, tenantId: TENANT_ID },
    );

    const analytics = await getWorkflowAnalytics({ db, tenantId: TENANT_ID });

    const kindRow = analytics.byKind.find((r) => r.kind === KIND);
    expect(kindRow?.runCount).toBe(2);
    expect(kindRow?.successCount).toBe(1);
    expect(kindRow?.successRate).toBe(0.5);
    // Run A: 14s, Run B: 3s → median 8500ms, avg 8500ms.
    expect(kindRow?.medianDurationMs).toBe(8_500);
    expect(kindRow?.avgDurationMs).toBe(8_500);

    // Deterministic fetch: run A 5000ms, run B 1000ms → median 3000ms.
    const fetchRow = analytics.byStepKind.find(
      (r) => r.stepKind === "deterministic",
    );
    expect(fetchRow?.stepCount).toBe(2);
    expect(fetchRow?.medianDurationMs).toBe(3_000);

    // Human gate appears once (run A) with a 2s wait.
    const gateRow = analytics.byStepKind.find((r) => r.stepKind === "human");
    expect(gateRow?.stepCount).toBe(1);
    expect(gateRow?.avgGateWaitMs).toBe(2_000);
    expect(gateRow?.medianGateWaitMs).toBe(2_000);
  });
});

describe("reprojectWorkflowFacts — rebuild is a pure derived cache", () => {
  test("rebuilds identical facts after a wipe", async () => {
    await commitRunLog(RUN_ID);
    await db.insert(schema.workflowRunRecord).values({
      id: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      kind: KIND,
      tenantId: TENANT_ID,
      principalId: "prn-facts",
      status: "failed",
      input: {},
    });

    // Initial projection.
    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      { repoId: REPO_ID, runId: RUN_ID, kind: KIND, tenantId: TENANT_ID },
    );
    const before = await getWorkflowRunBreakdown({
      db,
      tenantId: TENANT_ID,
      runId: RUN_ID,
    });

    // Wipe the fact store entirely.
    await db.delete(schema.workflowStepFact);
    await db.delete(schema.workflowRunFact);
    expect(
      await getWorkflowRunBreakdown({ db, tenantId: TENANT_ID, runId: RUN_ID }),
    ).toBeNull();

    // Reproject from the logs alone.
    const result = await reprojectWorkflowFacts(
      { db, repoStore: agentRepoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      { tenantId: TENANT_ID },
    );
    expect(result.projected).toBe(1);

    const after = await getWorkflowRunBreakdown({
      db,
      tenantId: TENANT_ID,
      runId: RUN_ID,
    });
    expect(after).toEqual(before);
  });
});

// ─── CL-2670 review fixes ──────────────────────────────────────────────

const DUAL_KIND = "dual-gate";
const DUAL_DEF_REPO_ID: RepoId = { kind: "workflow", id: DUAL_KIND };

// Two concurrent awaitSignal gates on independent DAG branches (no dependency
// between them), so both are awaited at once — the case where "attribute a
// received signal to the most recently awaited gate" mis-assigns the wait.
const DUAL_DEFINITION = defineWorkflow({
  id: DUAL_KIND,
  triggers: [{ type: "manual" }],
  steps: {
    gateA: awaitSignal({ name: "approvalA" }),
    gateB: awaitSignal({ name: "approvalB" }),
  },
});

async function commitEvents(
  runId: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const files: Record<string, string> = {};
  for (const event of events) {
    files[`runs/${runId}/events/${String(event["seq"])}.json`] =
      JSON.stringify(event);
  }
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files,
    message: `run log ${runId}`,
  });
}

async function deployDualDefinition(): Promise<void> {
  await repoStore.writeTree(HUB_PRINCIPAL, DUAL_DEF_REPO_ID, RUN_EVENT_REF, {
    files: { "workflow.json": JSON.stringify(DUAL_DEFINITION) },
    message: "dual definition",
  });
}

describe("concurrent awaitSignal gates — wait attributed by signalName", () => {
  test("each gate gets its own gate-wait, correlated by signal name not await order", async () => {
    await deployDualDefinition();
    // gateA awaited at t2, gateB awaited at t3. approvalA is RECEIVED FIRST (t5)
    // even though gateB was the most-recently-awaited gate — the buggy
    // "lastAwaitedStep" path would credit gateB with approvalA's wait and leave
    // gateA with none. Correct correlation: gateA=t5-t2=3s, gateB=t10-t3=7s.
    await commitEvents("wfr-dual", [
      {
        seq: 1,
        type: "RunStarted",
        runId: "wfr-dual",
        at: t(1),
        definitionHash: "h",
        trigger: { type: "manual", payload: {} },
      },
      {
        seq: 2,
        type: "StepStarted",
        stepId: "gateA",
        at: t(2),
        attempt: 1,
        input: {},
      },
      {
        seq: 3,
        type: "SignalAwaited",
        stepId: "gateA",
        at: t(2),
        signalName: "approvalA",
      },
      {
        seq: 4,
        type: "StepStarted",
        stepId: "gateB",
        at: t(3),
        attempt: 1,
        input: {},
      },
      {
        seq: 5,
        type: "SignalAwaited",
        stepId: "gateB",
        at: t(3),
        signalName: "approvalB",
      },
      {
        seq: 6,
        type: "SignalReceived",
        at: t(5),
        signalName: "approvalA",
        signalId: "sigA",
        payload: {},
      },
      {
        seq: 7,
        type: "StepCompleted",
        stepId: "gateA",
        at: t(6),
        attempt: 1,
        output: {},
      },
      {
        seq: 8,
        type: "SignalReceived",
        at: t(10),
        signalName: "approvalB",
        signalId: "sigB",
        payload: {},
      },
      {
        seq: 9,
        type: "StepCompleted",
        stepId: "gateB",
        at: t(11),
        attempt: 1,
        output: {},
      },
      { seq: 10, type: "RunCompleted", at: t(12) },
    ]);

    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      {
        repoId: REPO_ID,
        runId: "wfr-dual",
        kind: DUAL_KIND,
        tenantId: TENANT_ID,
      },
    );

    const breakdown = await getWorkflowRunBreakdown({
      db,
      tenantId: TENANT_ID,
      runId: "wfr-dual",
    });
    const byId = new Map((breakdown?.steps ?? []).map((s) => [s.stepId, s]));
    expect(byId.get("gateA")?.gateWaitMs).toBe(3_000);
    expect(byId.get("gateB")?.gateWaitMs).toBe(7_000);
  });
});

describe("date-range analytics filter survives a reproject", () => {
  test("filters on the run's real startedAt, not the reproject createdAt", async () => {
    await commitRunLog(RUN_ID);
    await db.insert(schema.workflowRunRecord).values({
      id: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      kind: KIND,
      tenantId: TENANT_ID,
      principalId: "prn-facts",
      status: "failed",
      input: {},
    });
    await projectWorkflowRunFacts(
      { db, repoStore: agentRepoStore },
      { repoId: REPO_ID, runId: RUN_ID, kind: KIND, tenantId: TENANT_ID },
    );

    // Reproject: replaceRunFacts re-inserts every row with createdAt = now(), so
    // a createdAt-based range filter would key on "now", not the run's 2026-01-01
    // start time. The startedAt-based filter must still find the run in a window
    // around its real start.
    await reprojectWorkflowFacts(
      { db, repoStore: agentRepoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      { tenantId: TENANT_ID },
    );

    const inWindow = await getWorkflowAnalytics({
      db,
      tenantId: TENANT_ID,
      range: {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(inWindow.byKind.find((r) => r.kind === KIND)?.runCount).toBe(1);
    expect(
      inWindow.byStepKind.find((r) => r.stepKind === "human")?.stepCount,
    ).toBe(1);

    const outOfWindow = await getWorkflowAnalytics({
      db,
      tenantId: TENANT_ID,
      range: {
        startDate: "2025-01-01T00:00:00.000Z",
        endDate: "2025-12-31T00:00:00.000Z",
      },
    });
    expect(outOfWindow.byKind.find((r) => r.kind === KIND)).toBeUndefined();
    expect(outOfWindow.byStepKind.length).toBe(0);
  });
});
