import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  type AuthorizeFn,
  type KindHandler,
  type Principal,
  type RepoId,
  type RepoStore,
  type ValidatePushResult,
} from "@intx/hub-sessions";

import { schema } from "../db";
import type { HubDb } from "../db";
import { insertRunRecord, loadRunRecord } from "./run-store";
import { projectWorkflowRunRepo } from "./projection-bridge";

// Integration coverage for the on-disk -> DB projection seam
// `projectWorkflowRunRepo` self-declares as NOT UNIT-TESTED (projection-bridge.ts
// :349-362): it drives @intx `subscribeKind` (a live git-commit tail) and
// `createWorkflowRunBlobSubstrate` against a real workflow-run repo, then writes
// the folded status to the `workflow_run_record` row. Faking those at the @intx
// boundary would mock the very thing under test. This exercises the real
// components across the seam: a real on-disk repo with committed event blobs, the
// real subscribeKind drain, the real fold, and a real (PGlite) Postgres write.
//
// The DB is PGlite (in-process wasm Postgres) so the drizzle insert/update/query
// round-trips for real without external infra. `workflow_run_record` has no
// foreign keys, so the single-table DDL below is its entire dependency surface.
//
// The run repo is committed with a permissive kind handler: the production
// `workflowRunKindHandler` enforces a strict per-run event schema plus a
// workflow-process principal path scope (mirrored in the sibling
// blob-substrate.test.ts). `projectWorkflowRunRepo` reads via `subscribeKind`
// (which loads committed blobs at `runs/<runId>/events/<seq>.json` regardless of
// which handler validated the push), so a permissive handler faithfully exercises
// the seam under test without reimplementing the producer's event journal.

const RUN_EVENT_REF = "refs/heads/main";
const HUB_PRINCIPAL: Principal = { kind: "hub" };
const REPO_ID: RepoId = { kind: "workflow-run", id: "dep-projection-it" };

const allowAll: AuthorizeFn = () => ({ allowed: true });
const permissiveHandler: KindHandler = {
  kind: "workflow-run",
  directoryPrefix: "workflow-runs",
  validatePush(): ValidatePushResult {
    return { ok: true };
  },
  onRefUpdated() {
    /* no-op */
  },
};

const WORKFLOW_RUN_RECORD_DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

let tempDir: string;
let repoStore: RepoStore;
let signingKey: KeyPair;
let client: PGlite;
let db: HubDb;

async function commitEvent(
  runId: string,
  seq: number,
  event: Record<string, unknown>,
): Promise<void> {
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files: {
      [`runs/${runId}/events/${seq}.json`]: JSON.stringify({ seq, ...event }),
    },
    message: `${runId} event ${seq}`,
  });
}

async function seedRun(runId: string): Promise<void> {
  await insertRunRecord(db, {
    runId,
    deploymentId: REPO_ID.id,
    kind: "test-workflow",
    tenantId: "tn-it",
    principalId: "prn-it",
    input: { topic: "seam" },
  });
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "projection-it-"));
  signingKey = await generateKeyPair();
  repoStore = createRepoStore({
    dataDir: tempDir,
    signingKey,
    handlers: { "workflow-run": permissiveHandler },
    authorize: allowAll,
  });
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files: { ".gitignore": "" },
    message: "genesis",
  });

  client = new PGlite();
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client?.close();
  await fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch(() => {});
});

describe("projectWorkflowRunRepo — on-disk -> DB seam", () => {
  test("a committed SignalAwaited event drives the row to status 'awaiting'", async () => {
    const runId = "wfr-await";
    await seedRun(runId);
    await commitEvent(runId, 1, { type: "RunStarted" });
    await commitEvent(runId, 2, { type: "StepStarted", stepId: "gate" });
    await commitEvent(runId, 3, { type: "SignalAwaited", stepId: "gate" });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    const row = await loadRunRecord(db, runId);
    expect(row?.status).toBe("awaiting");
  });

  test("re-projection after a restart is idempotent — status stays 'awaiting'", async () => {
    const runId = "wfr-reproject";
    await seedRun(runId);
    await commitEvent(runId, 1, { type: "RunStarted" });
    await commitEvent(runId, 2, { type: "SignalAwaited", stepId: "review" });

    // First pack receipt.
    await projectWorkflowRunRepo(repoStore, db, REPO_ID);
    expect((await loadRunRecord(db, runId))?.status).toBe("awaiting");

    // A later pack (or a hub restart re-projecting its repo copy) replays the
    // full log to the same state — the fold is a total function of the events.
    await projectWorkflowRunRepo(repoStore, db, REPO_ID);
    const row = await loadRunRecord(db, runId);
    expect(row?.status).toBe("awaiting");
  });

  test("a signal received in a later commit flips 'awaiting' back to 'running'", async () => {
    const runId = "wfr-resume";
    await seedRun(runId);
    await commitEvent(runId, 1, { type: "SignalAwaited", stepId: "gate" });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);
    expect((await loadRunRecord(db, runId))?.status).toBe("awaiting");

    await commitEvent(runId, 2, { type: "SignalReceived", stepId: "gate" });
    await commitEvent(runId, 3, { type: "StepStarted", stepId: "generate" });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);
    const row = await loadRunRecord(db, runId);
    expect(row?.status).toBe("running");
  });

  test("run-level timing is stamped from RunStarted and the terminal event", async () => {
    const runId = "wfr-timing";
    await seedRun(runId);
    await commitEvent(runId, 1, {
      type: "RunStarted",
      at: "2026-01-01T00:00:01.000Z",
    });
    await commitEvent(runId, 2, { type: "StepStarted", stepId: "only" });
    await commitEvent(runId, 3, {
      type: "RunCompleted",
      at: "2026-01-01T00:00:08.000Z",
    });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    const rows = await db
      .select({
        status: schema.workflowRunRecord.status,
        startedAt: schema.workflowRunRecord.startedAt,
        endedAt: schema.workflowRunRecord.endedAt,
      })
      .from(schema.workflowRunRecord)
      .where(eq(schema.workflowRunRecord.id, runId));
    const row = rows[0];
    expect(row?.status).toBe("completed");
    expect(row?.startedAt?.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(row?.endedAt?.toISOString()).toBe("2026-01-01T00:00:08.000Z");
  });

  test("UPDATE-ONLY: an event log for an unseeded run leaves no row behind", async () => {
    const runId = "wfr-unseeded";
    await commitEvent(runId, 1, { type: "SignalAwaited", stepId: "gate" });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    expect(await loadRunRecord(db, runId)).toBeNull();
  });
});
