import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRunRecord, workflowRunStep } from "../db/schema";
import { getRunKindStats, listRunSteps } from "./run-store";

// CL-2727: the stats aggregation reads the per-step PROJECTION + run index — no
// git-log replay. Exercised over a real (PGlite) Postgres so the drizzle
// group/aggregate SQL and the TS fold round-trip for real. Both projection
// tables are workbench-owned and have no foreign keys, so the two-table DDL is
// the whole dependency surface.

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

const TENANT = "tn-stats";
const PRINCIPAL = "prn-stats";

let client: PGlite;
let db: HubDb;

async function seedRun(
  runId: string,
  kind: string,
  status: string,
  opts: { tenantId?: string; principalId?: string; deletedAt?: Date } = {},
): Promise<void> {
  await db.insert(workflowRunRecord).values({
    id: runId,
    kind,
    tenantId: opts.tenantId ?? TENANT,
    principalId: opts.principalId ?? PRINCIPAL,
    status: status as never,
    ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
  });
}

async function seedStep(
  runId: string,
  stepId: string,
  phase: string,
  timing?: { startedAt: string; endedAt: string },
): Promise<void> {
  await db.insert(workflowRunStep).values({
    runId,
    stepId,
    phase: phase as never,
    attempts: 1,
    startedAt: timing ? new Date(timing.startedAt) : null,
    endedAt: timing ? new Date(timing.endedAt) : null,
  });
}

beforeEach(async () => {
  client = new PGlite();
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  await client.exec(WORKFLOW_RUN_STEP_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
});

describe("getRunKindStats — by-kind aggregate from the projection", () => {
  test("counts runs by status and folds step phases + mean duration per kind", async () => {
    await seedRun("r1", "brief", "completed");
    await seedRun("r2", "brief", "failed");
    await seedRun("r3", "deck", "running");

    // brief/r1: two completed steps, 2s and 4s.
    await seedStep("r1", "fetch", "completed", {
      startedAt: "2026-03-01T00:00:00.000Z",
      endedAt: "2026-03-01T00:00:02.000Z",
    });
    await seedStep("r1", "emit", "completed", {
      startedAt: "2026-03-01T00:00:02.000Z",
      endedAt: "2026-03-01T00:00:06.000Z",
    });
    // brief/r2: one failed step (no timing → excluded from mean).
    await seedStep("r2", "fetch", "failed");
    // deck/r3: one in-flight step.
    await seedStep("r3", "gen", "in-flight");

    const stats = await getRunKindStats(db, [TENANT], PRINCIPAL);
    const byKind = new Map(stats.map((s) => [s.kind, s]));

    const brief = byKind.get("brief");
    expect(brief?.runs).toEqual({
      provisioning: 0,
      running: 0,
      awaiting: 0,
      completed: 1,
      failed: 1,
      total: 2,
    });
    expect(brief?.steps.total).toBe(3);
    expect(brief?.steps.byPhase).toEqual({ completed: 2, failed: 1 });
    // Mean of 2000ms and 4000ms; the timing-less failed step is excluded.
    expect(brief?.steps.avgDurationMs).toBe(3000);

    const deck = byKind.get("deck");
    expect(deck?.runs.running).toBe(1);
    expect(deck?.steps.avgDurationMs).toBeNull();
  });

  test("scopes to the principal + tenant chain and excludes soft-deleted runs", async () => {
    await seedRun("mine", "brief", "completed");
    await seedRun("other-principal", "brief", "completed", {
      principalId: "prn-someone-else",
    });
    await seedRun("other-tenant", "brief", "completed", {
      tenantId: "tn-other",
    });
    await seedRun("archived", "brief", "completed", {
      deletedAt: new Date(),
    });

    const stats = await getRunKindStats(db, [TENANT], PRINCIPAL);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.runs.total).toBe(1);
  });

  test("kind filter restricts the aggregate to one kind", async () => {
    await seedRun("r1", "brief", "completed");
    await seedRun("r2", "deck", "completed");

    const stats = await getRunKindStats(db, [TENANT], PRINCIPAL, "deck");
    expect(stats.map((s) => s.kind)).toEqual(["deck"]);
  });
});

describe("listRunSteps — solo run breakdown", () => {
  test("returns a run's steps ordered by start time", async () => {
    await seedRun("solo", "brief", "awaiting");
    await seedStep("solo", "second", "completed", {
      startedAt: "2026-03-01T00:00:05.000Z",
      endedAt: "2026-03-01T00:00:06.000Z",
    });
    await seedStep("solo", "first", "completed", {
      startedAt: "2026-03-01T00:00:01.000Z",
      endedAt: "2026-03-01T00:00:02.000Z",
    });
    await seedStep("solo", "gate", "awaiting-signal");

    const steps = await listRunSteps(db, "solo");
    // Ordered by started_at (nulls last in Postgres ASC), then step id.
    expect(steps.map((s) => s.stepId)).toEqual(["first", "second", "gate"]);
    expect(steps[2]?.phase).toBe("awaiting-signal");
    expect(steps[2]?.endedAt).toBeNull();
  });
});
