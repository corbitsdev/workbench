import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";
import {
  failDeadParkedRuns,
  failStalledScheduledRuns,
} from "./stalled-scheduled-run-reconciler";

// Real (PGlite) round-trip for the stalled scheduled-run reconciler (CL-3509):
// only scheduler-sourced runs parked at a gate past the timeout are failed;
// interactive runs and recently-parked scheduler runs are untouched. Also
// covers the dead-parked-run sweep (any run `awaiting` a gate with a sibling
// step already `failed`), which shares this rail.
const DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    pending_signal jsonb,
    origin_conversation_id text,
    trigger_source text,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );

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
    UNIQUE (run_id, step_id)
  );
`;

let client: PGlite;
let db: HubDb;

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const TIMEOUT_MS = 60 * 60 * 1000;
const OLD = new Date(NOW - TIMEOUT_MS - 60_000).toISOString();
const RECENT = new Date(NOW - 60_000).toISOString();

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client.close();
});

async function seed(row: {
  id: string;
  status: string;
  triggerSource: string | null;
  updatedAt: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO workflow_run_record
      (id, kind, tenant_id, principal_id, status, trigger_source, updated_at)
     VALUES ($1, 'last30days-research', 't', 'p', $2, $3, $4)`,
    [row.id, row.status, row.triggerSource, row.updatedAt],
  );
}

async function seedStep(row: {
  runId: string;
  stepId: string;
  phase: string;
  errorMessage?: string;
  // Defaults `true` for a hand-seeded `failed` step in these tests, which is
  // deliberately the "permanently dead" case unless a test says otherwise —
  // matches every pre-existing test's intent before the column existed.
  retriesExhausted?: boolean;
}): Promise<void> {
  await client.query(
    `INSERT INTO workflow_run_step (run_id, step_id, phase, error_message, retries_exhausted)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      row.runId,
      row.stepId,
      row.phase,
      row.errorMessage ?? null,
      row.retriesExhausted ?? true,
    ],
  );
}

async function statusOf(id: string): Promise<string | undefined> {
  const [r] = await db
    .select({ status: workflowRunRecord.status })
    .from(workflowRunRecord)
    .where(eq(workflowRunRecord.id, id));
  return r?.status;
}

describe("failStalledScheduledRuns", () => {
  test("fails a scheduler run parked awaiting past the timeout", async () => {
    await seed({
      id: "stale",
      status: "awaiting",
      triggerSource: "scheduler",
      updatedAt: OLD,
    });
    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
    });
    expect(failed).toBe(1);
    expect(await statusOf("stale")).toBe("failed");
  });

  test("leaves an interactive awaiting run untouched even when old", async () => {
    await seed({
      id: "interactive",
      status: "awaiting",
      triggerSource: null,
      updatedAt: OLD,
    });
    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
    });
    expect(failed).toBe(0);
    expect(await statusOf("interactive")).toBe("awaiting");
  });

  test("leaves a recently-parked scheduler run untouched", async () => {
    await seed({
      id: "fresh",
      status: "awaiting",
      triggerSource: "scheduler",
      updatedAt: RECENT,
    });
    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
    });
    expect(failed).toBe(0);
    expect(await statusOf("fresh")).toBe("awaiting");
  });

  test("leaves a running scheduler run untouched (only awaiting is swept)", async () => {
    await seed({
      id: "running",
      status: "running",
      triggerSource: "scheduler",
      updatedAt: OLD,
    });
    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
    });
    expect(failed).toBe(0);
    expect(await statusOf("running")).toBe("running");
  });
});

describe("failDeadParkedRuns", () => {
  test("settles a run parked at a gate with a failed sibling step as failed, naming the failing step", async () => {
    await seed({
      id: "dead",
      status: "awaiting",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({
      runId: "dead",
      stepId: "enrich",
      phase: "failed",
      errorMessage: "enrichment API returned 500",
    });
    await seedStep({
      runId: "dead",
      stepId: "review-gate",
      phase: "awaiting-signal",
    });

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(1);
    expect(await statusOf("dead")).toBe("failed");
  });

  test("leaves a run parked at a gate with NO failed step untouched", async () => {
    await seed({
      id: "healthy-gate",
      status: "awaiting",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({
      runId: "healthy-gate",
      stepId: "review-gate",
      phase: "awaiting-signal",
    });

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(0);
    expect(await statusOf("healthy-gate")).toBe("awaiting");
  });

  test("leaves a healthy running run untouched even if a later step already failed", async () => {
    // Not parked at a gate (still `running`) -- out of scope for this sweep;
    // the liveness sweep / orphan-fail paths own a still-running run.
    await seed({
      id: "still-running",
      status: "running",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({
      runId: "still-running",
      stepId: "enrich",
      phase: "failed",
    });

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(0);
    expect(await statusOf("still-running")).toBe("running");
  });

  test("is idempotent -- a second sweep changes nothing", async () => {
    await seed({
      id: "dead-2",
      status: "awaiting",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({ runId: "dead-2", stepId: "enrich", phase: "failed" });

    const first = await failDeadParkedRuns(db);
    expect(first).toBe(1);
    expect(await statusOf("dead-2")).toBe("failed");

    const second = await failDeadParkedRuns(db);
    expect(second).toBe(0);
    expect(await statusOf("dead-2")).toBe("failed");
  });

  test("leaves a run untouched when the failed step is still retrying (retries not exhausted)", async () => {
    // The false-positive review caught: `phase = 'failed'` is a re-entrancy
    // marker the runtime revisits between attempts, not a terminal verdict.
    // A step mid-backoff must never settle the run out from under a
    // legitimately-parked human gate on an independent branch.
    await seed({
      id: "retrying",
      status: "awaiting",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({
      runId: "retrying",
      stepId: "enrich",
      phase: "failed",
      retriesExhausted: false,
    });
    await seedStep({
      runId: "retrying",
      stepId: "review-gate",
      phase: "awaiting-signal",
    });

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(0);
    expect(await statusOf("retrying")).toBe("awaiting");
  });

  test("leaves a soft-deleted run untouched", async () => {
    await seed({
      id: "deleted",
      status: "awaiting",
      triggerSource: null,
      updatedAt: RECENT,
    });
    await seedStep({ runId: "deleted", stepId: "enrich", phase: "failed" });
    await client.query(
      `UPDATE workflow_run_record SET deleted_at = now() WHERE id = $1`,
      ["deleted"],
    );

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(0);
    expect(await statusOf("deleted")).toBe("awaiting");
  });
});
