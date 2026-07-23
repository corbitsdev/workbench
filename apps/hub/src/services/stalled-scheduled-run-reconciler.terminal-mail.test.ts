import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { HubDb } from "../db";
import { schema } from "../db";
import type { MailboxWriteArgs } from "../lib/mailbox-write";
import { resetFailureNotificationBreaker } from "../workflow-executor/failure-notification-breaker";

// CL-4289: a scheduled run failed by the stalled-run sweep must tell its
// owner, not just flip a DB column. Mocks only the real leaf write boundary
// (writeMailboxMessage) — everything above it (failStalledScheduledRuns ->
// deliverRunTerminalMail -> readMemberPreferences) runs for real against a
// PGlite database, so the assertion is on genuine composed mail content, not
// a self-authored stub.
const insertCalls: MailboxWriteArgs[] = [];

mock.module("../lib/mailbox-write", () => ({
  writeMailboxMessage: async (_db: HubDb, args: MailboxWriteArgs) => {
    insertCalls.push(args);
    return { id: `pmb-${insertCalls.length}` };
  },
}));

const { failStalledScheduledRuns, failDeadParkedRuns } = await import(
  "./stalled-scheduled-run-reconciler"
);

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
  CREATE TABLE tenant (
    id text PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL,
    domain text NOT NULL,
    parent_id text,
    config jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE principal (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    status text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE member_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    member_principal_id text NOT NULL,
    preferences jsonb NOT NULL DEFAULT '{}',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
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

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  await client.query(
    `INSERT INTO tenant (id, name, slug, domain) VALUES ('t', 'Acme', 'acme', 'acme.example')`,
  );
  await client.query(
    `INSERT INTO principal (id, tenant_id, kind, ref_id, status) VALUES ('p', 't', 'user', 'alice', 'active')`,
  );
  db = drizzle(client, { schema }) as unknown as HubDb;
  insertCalls.length = 0;
  resetFailureNotificationBreaker();
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
  errorMessage?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO workflow_run_step (run_id, step_id, phase, error_message, retries_exhausted)
     VALUES ($1, $2, 'failed', $3, true)`,
    [row.runId, row.stepId, row.errorMessage ?? null],
  );
}

describe("failStalledScheduledRuns terminal mail (CL-4289)", () => {
  test("notifies the owner when a stalled scheduled run is failed", async () => {
    await seed({
      id: "stale",
      status: "awaiting",
      triggerSource: "scheduler",
      updatedAt: OLD,
    });

    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
      mailDeps: { deploymentDomain: "wf.example" },
    });

    expect(failed).toBe(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      tenantId: "t",
      principalId: "p",
      fromAddress: "hub@wf.example",
      subject: "Workflow run failed: last30days-research",
    });
    expect(insertCalls[0]?.body).toContain("stale");
    // Names the actual deadline rather than generic "parked" copy (review note).
    expect(insertCalls[0]?.body).toContain("did not resolve within 60 minutes");
  });

  test("does not mail when mailDeps is omitted (back-compat)", async () => {
    await seed({
      id: "stale2",
      status: "awaiting",
      triggerSource: "scheduler",
      updatedAt: OLD,
    });

    const failed = await failStalledScheduledRuns(db, {
      timeoutMs: TIMEOUT_MS,
      now: () => NOW,
    });

    expect(failed).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("failDeadParkedRuns terminal mail (CL-4289)", () => {
  test("notifies the owner naming the step that actually failed", async () => {
    await seed({
      id: "dead",
      status: "awaiting",
      triggerSource: null,
      updatedAt: OLD,
    });
    await seedStep({
      runId: "dead",
      stepId: "enrich",
      errorMessage: "enrichment API returned 500",
    });

    const failed = await failDeadParkedRuns(db, {
      mailDeps: { deploymentDomain: "wf.example" },
    });

    expect(failed).toBe(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      tenantId: "t",
      principalId: "p",
      fromAddress: "hub@wf.example",
      subject: "Workflow run failed: last30days-research",
    });
    // Names the dead step and its error, not the generic parked-timeout copy
    // failStalledScheduledRuns uses -- the two failures are distinguishable.
    expect(insertCalls[0]?.body).toContain("enrich");
    expect(insertCalls[0]?.body).toContain("enrichment API returned 500");
    expect(insertCalls[0]?.body).not.toContain("did not resolve within");
  });

  test("does not mail when mailDeps is omitted (back-compat)", async () => {
    await seed({
      id: "dead2",
      status: "awaiting",
      triggerSource: null,
      updatedAt: OLD,
    });
    await seedStep({ runId: "dead2", stepId: "enrich" });

    const failed = await failDeadParkedRuns(db);

    expect(failed).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });
});
