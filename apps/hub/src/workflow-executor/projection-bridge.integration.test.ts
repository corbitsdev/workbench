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
import { workflowRunRecord } from "../db/schema";
import { insertRunRecord, listRunSteps, loadRunRecord } from "./run-store";
import {
  projectWorkflowRunRepo,
  seedMissingRunRecordsFromRepo,
  type OnNewlyAwaitingFn,
} from "./projection-bridge";
import { createRunLivenessSweep } from "../services/run-liveness-sweep";

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
    origin_conversation_id text,
    pending_signal jsonb,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

// CL-2727: the per-step projection table the bridge upserts alongside the
// run-level status. No foreign keys — the projection upserts steps for whatever
// run its log names.
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
    originConversationId: null,
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
  await client.exec(WORKFLOW_RUN_STEP_DDL);
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

  test("seedMissingRunRecordsFromRepo backfills an orphan log then projection updates it", async () => {
    const runId = "wfr-orphan-backfill";
    await commitEvent(runId, 1, {
      type: "RunStarted",
      at: "2026-03-01T00:00:00.000Z",
    });
    await commitEvent(runId, 2, {
      type: "RunCompleted",
      at: "2026-03-01T00:00:05.000Z",
    });

    const seeded = await seedMissingRunRecordsFromRepo(repoStore, db, REPO_ID, {
      kind: "test-workflow",
      tenantId: "tn-it",
      principalId: "prn-it",
      deploymentId: REPO_ID.id,
    });
    expect(seeded).toEqual([runId]);

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    const row = await loadRunRecord(db, runId);
    expect(row?.status).toBe("completed");
  });

  // CL-2727: the per-step projection derived from the SAME native fold. Asserts
  // each step's phase, attempt count, and wall-clock timing land in
  // workflow_run_step over the real on-disk log → DB seam.
  test("per-step phases, attempts, and timing project into workflow_run_step", async () => {
    const runId = "wfr-steps";
    await seedRun(runId);
    // A retried-then-completed step, a gate parked awaiting a signal, and a
    // freshly-started in-flight step.
    await commitEvent(runId, 1, {
      type: "RunStarted",
      at: "2026-02-01T00:00:00.000Z",
    });
    await commitEvent(runId, 2, {
      type: "StepStarted",
      stepId: "fetch",
      at: "2026-02-01T00:00:01.000Z",
      attempt: 1,
    });
    await commitEvent(runId, 3, {
      type: "StepFailed",
      stepId: "fetch",
      at: "2026-02-01T00:00:02.000Z",
      attempt: 1,
      error: { message: "transient" },
      retriesExhausted: false,
    });
    await commitEvent(runId, 4, {
      type: "TimerSet",
      timerId: "tmr-1",
      at: "2026-02-01T00:00:02.500Z",
      fireAt: "2026-02-01T00:00:03.000Z",
      stepId: "fetch",
    });
    await commitEvent(runId, 5, {
      type: "AttemptScheduled",
      stepId: "fetch",
      at: "2026-02-01T00:00:03.000Z",
      nextAttempt: 2,
      timerId: "tmr-1",
      fireAt: "2026-02-01T00:00:03.000Z",
    });
    await commitEvent(runId, 6, {
      type: "TimerFired",
      timerId: "tmr-1",
      at: "2026-02-01T00:00:03.500Z",
    });
    await commitEvent(runId, 7, {
      type: "StepCompleted",
      stepId: "fetch",
      at: "2026-02-01T00:00:05.000Z",
      attempt: 2,
      output: { ref: "r-fetch" },
    });
    await commitEvent(runId, 8, {
      type: "StepStarted",
      stepId: "gate",
      at: "2026-02-01T00:00:06.000Z",
      attempt: 1,
    });
    await commitEvent(runId, 9, {
      type: "SignalAwaited",
      stepId: "gate",
      at: "2026-02-01T00:00:07.000Z",
      signalName: "approval",
    });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    const steps = await listRunSteps(db, runId);
    const byId = new Map(steps.map((s) => [s.stepId, s]));

    const fetch = byId.get("fetch");
    expect(fetch?.phase).toBe("completed");
    expect(fetch?.attempts).toBe(2);
    expect(fetch?.startedAt?.toISOString()).toBe("2026-02-01T00:00:01.000Z");
    expect(fetch?.endedAt?.toISOString()).toBe("2026-02-01T00:00:05.000Z");

    const gate = byId.get("gate");
    expect(gate?.phase).toBe("awaiting-signal");
    expect(gate?.endedAt).toBeNull();
  });

  // CL-2727 SWEEP → PACK RESURRECTION: the liveness sweep's terminal write is
  // best-effort. A stale no-progress run is failed by the sweep, then a real pack
  // arrives (RunStarted / StepStarted). `applyRunProjection` overwrites the
  // status UNCONDITIONALLY (the intentional self-heal path), so the run returns
  // to `running`. Because the run was `failed` (terminal) before this projection,
  // `becameTerminal(failed → running)` is false — neither the reclaim nor the
  // facts callback fires. This is the seam the sweep + bridge share: sweep-fail
  // must never strand a run that is actually alive.
  test("a sweep-failed run resurrects to running on the next pack, firing no reclaim/facts callback", async () => {
    const runId = "wfr-resurrect";
    await seedRun(runId);
    // Backdate updatedAt so the sweep treats it as a stale candidate (INSERT does
    // not trip the $onUpdate clock, so the write persists).
    await db
      .update(workflowRunRecord)
      .set({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(workflowRunRecord.id, runId));

    // GONE supervisor + no progress (no RunStarted, no steps) → the sweep fails it.
    const sweep = createRunLivenessSweep({
      db,
      getRoutableAddresses: () => [],
      deploymentDomain: "wf.localhost",
      stallGraceMs: 60 * 1000,
    });
    const swept = await sweep.sweepOnce();
    expect(swept.failed).toBe(1);
    expect((await loadRunRecord(db, runId))?.status).toBe("failed");

    // A real pack now lands: the supervisor DID start and ran a step.
    await commitEvent(runId, 1, { type: "RunStarted" });
    await commitEvent(runId, 2, { type: "StepStarted", stepId: "fetch" });

    let reclaimCalls = 0;
    let factsCalls = 0;
    await projectWorkflowRunRepo(
      repoStore,
      db,
      REPO_ID,
      () => {
        reclaimCalls += 1;
      },
      () => {
        factsCalls += 1;
      },
    );

    // Self-heal: the log fold's real state wins.
    expect((await loadRunRecord(db, runId))?.status).toBe("running");
    // No spurious terminal-transition side effects (failed → running is not a
    // non-terminal → terminal edge).
    expect(reclaimCalls).toBe(0);
    expect(factsCalls).toBe(0);
  });

  // The gate-mail hook fires when a run FIRST parks on an awaitSignal
  // gate, carrying the run's owner + identity so the caller can deliver mail.
  test("fires onNewlyAwaiting once when a run first parks on a gate", async () => {
    const runId = "wfr-gatemail";
    await seedRun(runId);
    const calls: Parameters<OnNewlyAwaitingFn>[0][] = [];
    const onNewlyAwaiting: OnNewlyAwaitingFn = (a) => calls.push(a);

    await commitEvent(runId, 1, { type: "RunStarted" });
    await commitEvent(runId, 2, { type: "StepStarted", stepId: "gate" });
    await commitEvent(runId, 3, { type: "SignalAwaited", stepId: "gate" });

    await projectWorkflowRunRepo(
      repoStore,
      db,
      REPO_ID,
      undefined,
      undefined,
      onNewlyAwaiting,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId,
      kind: "test-workflow",
      tenantId: "tn-it",
      principalId: "prn-it",
      deploymentId: REPO_ID.id,
    });

    // Re-projection of the same still-parked run does NOT re-fire (the DB row is
    // already `awaiting`, so it is not a transition).
    await projectWorkflowRunRepo(
      repoStore,
      db,
      REPO_ID,
      undefined,
      undefined,
      onNewlyAwaiting,
    );
    expect(calls).toHaveLength(1);
  });

  test("fires onNewlyAwaiting again when a run re-parks on a new gate", async () => {
    const runId = "wfr-regate";
    await seedRun(runId);
    const calls: Parameters<OnNewlyAwaitingFn>[0][] = [];
    const onNewlyAwaiting: OnNewlyAwaitingFn = (a) => calls.push(a);

    await commitEvent(runId, 1, { type: "SignalAwaited", stepId: "gate-a" });
    await projectWorkflowRunRepo(
      repoStore,
      db,
      REPO_ID,
      undefined,
      undefined,
      onNewlyAwaiting,
    );
    expect(calls).toHaveLength(1);

    // A signal lands and the run immediately parks on a second gate — both events
    // fold in one pack, keeping the folded status `awaiting`. The owner must still
    // be notified of the NEW gate, so the hook fires again.
    await commitEvent(runId, 2, {
      type: "SignalReceived",
      stepId: "gate-a",
      signalId: "sig-1",
    });
    await commitEvent(runId, 3, { type: "SignalAwaited", stepId: "gate-b" });
    await projectWorkflowRunRepo(
      repoStore,
      db,
      REPO_ID,
      undefined,
      undefined,
      onNewlyAwaiting,
    );
    expect(calls).toHaveLength(2);
  });

  test("re-projection updates a step's phase in place (idempotent upsert)", async () => {
    const runId = "wfr-step-reproject";
    await seedRun(runId);
    await commitEvent(runId, 1, { type: "RunStarted" });
    await commitEvent(runId, 2, { type: "StepStarted", stepId: "only" });

    await projectWorkflowRunRepo(repoStore, db, REPO_ID);
    expect((await listRunSteps(db, runId))[0]?.phase).toBe("in-flight");

    await commitEvent(runId, 3, {
      type: "StepCompleted",
      stepId: "only",
      output: { ref: "r" },
    });
    await projectWorkflowRunRepo(repoStore, db, REPO_ID);

    const steps = await listRunSteps(db, runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.phase).toBe("completed");
  });
});
