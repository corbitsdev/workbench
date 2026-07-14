import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";
import { failStalledScheduledRuns } from "./stalled-scheduled-run-reconciler";

// Real (PGlite) round-trip for the stalled scheduled-run reconciler (CL-3509):
// only scheduler-sourced runs parked at a gate past the timeout are failed;
// interactive runs and recently-parked scheduler runs are untouched.
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
