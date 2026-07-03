import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";

// CL-2751: capture the sweep's structured @intx/log output so the rollout can be
// watched in prod. Mocked at the module boundary; each info record is recorded
// with its message + meta so the fail-decision fields and the per-interval
// summary counts can be asserted for real.
const infoLogs: { msg: string; meta?: Record<string, unknown> }[] = [];
mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: (msg: string, meta?: Record<string, unknown>) =>
      infoLogs.push({ msg, meta }),
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRunRecord, workflowRunStep } from "../db/schema";

// The sweep captures its logger at module load (top-level `getLogger`), so it
// must be imported AFTER the `@intx/log` mock is registered. A static import is
// hoisted above the mock; a dynamic import is not.
const { createRunLivenessSweep } = await import("./run-liveness-sweep");

const DEPLOYMENT_DOMAIN = "wf.localhost";
const TENANT = "tn-sweep";

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
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

const WORKFLOW_RUN_STEP_DDL = `
  CREATE TABLE workflow_run_step (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id text NOT NULL,
    step_id text NOT NULL,
    phase text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT workflow_run_step_run_step_uniq UNIQUE (run_id, step_id)
  );
`;

let client: PGlite;
let db: HubDb;

async function seedRun(
  runId: string,
  deploymentId: string | null,
  status: string,
  updatedAt: Date,
  opts: { startedAt?: Date } = {},
): Promise<void> {
  await db.insert(workflowRunRecord).values({
    id: runId,
    deploymentId,
    kind: "brief",
    tenantId: TENANT,
    principalId: "prn-sweep",
    status: status as never,
    updatedAt,
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
  });
}

async function seedStep(runId: string, stepId: string): Promise<void> {
  await db.insert(workflowRunStep).values({
    runId,
    stepId,
    phase: "in-flight" as never,
    attempts: 1,
    startedAt: new Date(),
  });
}

const STALE = new Date(Date.now() - 10 * 60 * 1000);

function failDecisions() {
  return infoLogs.filter(
    (l) => l.msg === "run liveness sweep: failed stale run",
  );
}

function sparedDecisions() {
  return infoLogs.filter(
    (l) => l.msg === "run liveness sweep: spared stale run",
  );
}

function summary() {
  return infoLogs.find((l) => l.msg === "run liveness sweep pass summary")
    ?.meta;
}

beforeEach(async () => {
  infoLogs.length = 0;
  client = new PGlite();
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  await client.exec(WORKFLOW_RUN_STEP_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
});

describe("createRunLivenessSweep — CL-2751 observability", () => {
  test("emits a gone-supervisor fail decision with the right fields", async () => {
    await seedRun("dead", "ses_dead", "running", STALE);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    await sweep.sweepOnce();

    const decisions = failDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.meta).toMatchObject({
      runId: "dead",
      tenantId: TENANT,
      reason: "gone-supervisor",
      spared: false,
      casFlipped: true,
    });
    // idleMs reflects ~10m of staleness.
    expect(decisions[0]?.meta?.idleMs).toBeGreaterThanOrEqual(9 * 60 * 1000);

    expect(summary()).toMatchObject({
      scanned: 1,
      considered: 1,
      failed: 1,
      failedGoneSupervisor: 1,
      failedPastHardDeadline: 0,
      sparedByRecheck: 0,
    });
  });

  test("emits a past-start-hard-deadline fail decision with the right fields", async () => {
    await seedRun("never-starts", "ses_never", "running", STALE);
    const address = deriveDeploymentAddress({
      deploymentId: "ses_never",
      deploymentDomain: DEPLOYMENT_DOMAIN,
    });

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [address],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
      startHardDeadlineMs: 5 * 60 * 1000,
    });
    await sweep.sweepOnce();

    const decisions = failDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.meta).toMatchObject({
      runId: "never-starts",
      tenantId: TENANT,
      reason: "past-start-hard-deadline",
      spared: false,
      casFlipped: true,
    });

    expect(summary()).toMatchObject({
      scanned: 1,
      considered: 1,
      failed: 1,
      failedGoneSupervisor: 0,
      failedPastHardDeadline: 1,
      sparedByRecheck: 0,
    });
  });

  test("emits a spared decision (progress lands before the CAS) and counts it", async () => {
    await seedRun("racer", null, "running", STALE);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });

    const pass = sweep.sweepOnce();
    await db
      .update(workflowRunRecord)
      .set({ startedAt: new Date() })
      .where(eq(workflowRunRecord.id, "racer"));
    await pass;

    expect(failDecisions()).toHaveLength(0);
    const spared = sparedDecisions();
    expect(spared).toHaveLength(1);
    expect(spared[0]?.meta).toMatchObject({
      runId: "racer",
      tenantId: TENANT,
      reason: "gone-supervisor",
      spared: true,
      casFlipped: false,
    });

    expect(summary()).toMatchObject({
      scanned: 1,
      considered: 1,
      failed: 0,
      sparedByRecheck: 1,
    });
  });

  test("summary aggregates counts across multiple candidates", async () => {
    await seedRun("dead-a", "ses_a", "running", STALE);
    await seedRun("dead-b", "ses_b", "running", STALE);
    await seedRun("mid", "ses_mid", "running", STALE, {
      startedAt: new Date(Date.now() - 8 * 60 * 1000),
    });
    await seedStep("mid", "generate");

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    await sweep.sweepOnce();

    expect(failDecisions()).toHaveLength(3);
    expect(summary()).toMatchObject({
      scanned: 3,
      considered: 3,
      failed: 3,
      failedGoneSupervisor: 3,
      failedPastHardDeadline: 0,
      sparedByRecheck: 0,
    });
  });
});
