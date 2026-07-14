import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "../db";
import type { HubDb } from "../db";
import { insertRunRecord, loadRunRecord } from "../workflow-executor/run-store";
import {
  extractStoredIntake,
  queueScheduledIntakeSignal,
} from "./scheduled-intake";

// The intake auto-delivery seam (CL-3509): a scheduled run's stored intake is
// turned into a durable pending `intake` signal on the run record — the SAME rail
// the awaiting reconciler re-delivers to the parked run until receipt. Exercises
// the real drizzle write + the real intake validation (Last30daysIntakePayload),
// not a mock, so a scheduled last30days-research run with a stored topic reaches
// its first gate without a human.
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

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client.close();
});

async function seedRun(runId: string): Promise<void> {
  await insertRunRecord(db, {
    runId,
    deploymentId: "dep-1",
    kind: "last30days-research",
    tenantId: "tenant-root",
    principalId: "principal-a",
    input: { userAddress: "usr_a", userRefId: "a" },
    originConversationId: null,
    triggerSource: "scheduler",
  });
}

describe("extractStoredIntake", () => {
  test("strips the server-owned identity keys", () => {
    expect(
      extractStoredIntake({
        topic: "AI agents",
        focus: "GTM",
        userAddress: "usr_a",
        userRefId: "a",
      }),
    ).toEqual({ topic: "AI agents", focus: "GTM" });
  });

  test("is empty when only identity keys are present", () => {
    expect(
      extractStoredIntake({ userAddress: "usr_a", userRefId: "a" }),
    ).toEqual({});
  });
});

describe("queueScheduledIntakeSignal", () => {
  test("persists a durable pending intake signal for a valid stored intake", async () => {
    await seedRun("run-1");
    const queued = await queueScheduledIntakeSignal(db, {
      runId: "run-1",
      kind: "last30days-research",
      intake: { topic: "AI coding agents for GTM teams" },
    });
    expect(queued).toBe(true);

    const state = await loadRunRecord(db, "run-1");
    expect(state?.pendingSignal?.signalName).toBe("intake");
    expect(state?.pendingSignal?.payload).toEqual({
      topic: "AI coding agents for GTM teams",
    });
    expect(typeof state?.pendingSignal?.signalId).toBe("string");
  });

  test("does not queue an empty intake", async () => {
    await seedRun("run-2");
    const queued = await queueScheduledIntakeSignal(db, {
      runId: "run-2",
      kind: "last30days-research",
      intake: {},
    });
    expect(queued).toBe(false);
    const state = await loadRunRecord(db, "run-2");
    expect(state?.pendingSignal ?? null).toBeNull();
  });

  test("does not queue an intake that fails the workflow's intake schema", async () => {
    await seedRun("run-3");
    // last30days requires a non-empty topic; a blank topic must not be delivered.
    const queued = await queueScheduledIntakeSignal(db, {
      runId: "run-3",
      kind: "last30days-research",
      intake: { topic: "   " },
    });
    expect(queued).toBe(false);
    const state = await loadRunRecord(db, "run-3");
    expect(state?.pendingSignal ?? null).toBeNull();
  });
});
