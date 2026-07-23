import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRunRecord, workflowRunStep } from "../db/schema";
import { createRunLivenessSweep } from "./run-liveness-sweep";

// CL-2727: the continuous liveness sweep + its compare-and-set orphan-fail,
// exercised over a real (PGlite) Postgres so the CAS predicate (`WHERE status =
// 'running'`) round-trips for real. This is the regression-critical seam: the
// CAS is the CL-2575 invariant made structural — an `awaiting` run must NEVER be
// flipped to `failed`, even when its supervisor is absent from the routable set.

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
    trigger_source text,
    pending_signal jsonb,
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
    error_message text,
    retries_exhausted boolean NOT NULL DEFAULT false,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT workflow_run_step_run_step_uniq UNIQUE (run_id, step_id)
  );
`;

let client: PGlite;
let db: HubDb;

// Seed a run with an explicit stale updatedAt (an INSERT does not trip the
// $onUpdate clock, so the value persists as written). `startedAt` marks a run
// that has begun (RunStarted folded); omit it for a run-start hang.
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

async function statusOf(runId: string): Promise<string> {
  const rows = await client.query<{ status: string }>(
    "SELECT status FROM workflow_run_record WHERE id = $1",
    [runId],
  );
  return rows.rows[0]?.status ?? "MISSING";
}

const STALE = new Date(Date.now() - 10 * 60 * 1000);
const FRESH = new Date();

beforeEach(async () => {
  client = new PGlite();
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  await client.exec(WORKFLOW_RUN_STEP_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
});

describe("createRunLivenessSweep — stalled-run detection + CAS orphan-fail", () => {
  test("fails a stale running run whose supervisor is not routable", async () => {
    await seedRun("dead", "ses_dead", "running", STALE);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(1);
    expect(await statusOf("dead")).toBe("failed");
  });

  test("NEVER flips an awaiting run to failed, even with an absent supervisor (CL-2575)", async () => {
    await seedRun("parked", "ses_parked", "awaiting", STALE);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.scanned).toBe(0);
    expect(result.failed).toBe(0);
    expect(await statusOf("parked")).toBe("awaiting");
  });

  test("leaves a running run whose supervisor is routable AND has begun (a live, slow step)", async () => {
    // Has made progress: a folded RunStarted (startedAt) + an in-flight step.
    await seedRun("alive", "ses_alive", "running", STALE, {
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await seedStep("alive", "fetch");
    const address = deriveDeploymentAddress({
      deploymentId: "ses_alive",
      deploymentDomain: DEPLOYMENT_DOMAIN,
    });

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [address],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(0);
    expect(await statusOf("alive")).toBe("running");
  });

  // THE KEY FALSE-POSITIVE FIX (CL-2727): a legitimately slow FIRST step keeps a
  // ROUTABLE supervisor while emitting no early pack — no `startedAt`, no steps.
  // Past the short grace but UNDER the hard deadline it must be LEFT ALONE, or a
  // slow LLM/tool call or cold provisioning under load gets wrongly failed. This
  // is the one hard requirement: never fail a live run.
  test("leaves a routable run with NO progress that is under the start hard deadline (slow first step)", async () => {
    await seedRun("slow-start", "ses_slow", "running", STALE); // no startedAt, no steps
    const address = deriveDeploymentAddress({
      deploymentId: "ses_slow",
      deploymentDomain: DEPLOYMENT_DOMAIN,
    });

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [address], // supervisor IS routable
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000, // STALE (10m) is past the grace...
      startHardDeadlineMs: 30 * 60 * 1000, // ...but under the 30m hard deadline
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(0);
    expect(await statusOf("slow-start")).toBe("running");
  });

  // A routable supervisor that has emitted NOTHING for the whole hard deadline is
  // a genuine never-starts hang — fail it so the wedge is legible.
  test("fails a routable run with NO progress that is PAST the start hard deadline", async () => {
    await seedRun("never-starts", "ses_never", "running", STALE); // idle 10m
    const address = deriveDeploymentAddress({
      deploymentId: "ses_never",
      deploymentDomain: DEPLOYMENT_DOMAIN,
    });

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [address], // supervisor IS routable
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
      startHardDeadlineMs: 5 * 60 * 1000, // 10m idle > 5m hard deadline
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(1);
    expect(await statusOf("never-starts")).toBe("failed");
  });

  // Progress that appears DURING the pass (a first pack lands after the candidate
  // scan but before the per-run CAS) is spared by the pre-CAS recheck. This
  // exploits PGlite's single, serialized connection: the sweep's candidate +
  // step scans are issued (and observe NO progress) before this test's
  // `startedAt` update is applied, while the per-run recheck is issued after it
  // — so the recheck, and only the recheck, sees the progress and spares the run.
  test("spares a no-progress candidate whose progress lands before the CAS (pre-CAS recheck)", async () => {
    await seedRun("racer", null, "running", STALE); // GONE, no progress at scan

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });

    // Kick off the pass; it suspends at its candidate scan (issued first on the
    // connection). Stamp progress now — queued after that scan, before the
    // per-run recheck's read.
    const pass = sweep.sweepOnce();
    await db
      .update(workflowRunRecord)
      .set({ startedAt: new Date() })
      .where(eq(workflowRunRecord.id, "racer"));
    const result = await pass;

    expect(result.failed).toBe(0);
    expect(await statusOf("racer")).toBe("running");
  });

  // A GONE supervisor that HAD begun (progress at scan) is a genuine mid-step
  // orphan — the recheck must NOT spare it. This guards the `!madeProgress` gate
  // on the recheck: without it, the sweep would never fail the very orphan it
  // exists to catch.
  test("fails a GONE run that had already made progress (mid-step orphan)", async () => {
    await seedRun("orphan-midstep", "ses_orphan", "running", STALE, {
      startedAt: new Date(Date.now() - 8 * 60 * 1000),
    });
    await seedStep("orphan-midstep", "generate");

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [], // supervisor GONE
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(1);
    expect(await statusOf("orphan-midstep")).toBe("failed");
  });

  test("leaves a freshly-updated running run inside the stall grace window", async () => {
    await seedRun("recent", "ses_recent", "running", FRESH);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.scanned).toBe(0);
    expect(await statusOf("recent")).toBe("running");
  });

  test("does not resurrect or re-fail an already-terminal run", async () => {
    await seedRun("done", "ses_done", "completed", STALE);

    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: DEPLOYMENT_DOMAIN,
      stallGraceMs: 60 * 1000,
    });
    const result = await sweep.sweepOnce();

    expect(result.failed).toBe(0);
    expect(await statusOf("done")).toBe("completed");
  });
});
