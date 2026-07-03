import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { HubDb } from "../db";
import {
  workflowRunRecord,
  workflowRunStep,
  workflowRunStepPhases,
  type WorkflowRunRecordRow,
} from "../db/schema";

export type WorkflowRunStepPhase = (typeof workflowRunStepPhases)[number];

// The per-step projection input the bridge hands `upsertRunSteps` (CL-2727).
// Defined here (not imported from `run-state-from-log`) to keep `run-store` free
// of the run-state module's transitive route imports — the native
// `NativeRunStepProjection` is structurally assignable to this (its `phase` is
// exactly this enum union).
export interface RunStepProjectionInput {
  stepId: string;
  phase: WorkflowRunStepPhase;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
}

// The thin run INDEX shape (CL-2669). A run's authoritative per-step and run
// state is read from its native git event log (`run-state-from-log.ts`); this
// index row carries only run-level identity, ownership, kind, the coarse
// run-level `status`, and the deployment the run belongs to. The former
// step-level mirror (currentStepId / outputs / error) was removed.
export interface RunState {
  runId: string;
  kind: string;
  tenantId: string;
  principalId: string;
  status: "running" | "awaiting" | "completed" | "failed";
  // The deployment this run belongs to. Read by the records router to address
  // the sidecar supervisor for trigger/signal delivery.
  deploymentId?: string;
  // The conversation the run was started from (CL-2677); absent for
  // direct-started runs with no chat context.
  originConversationId?: string;
}

// The run-level projection the bridge writes on every pack (CL-2669): the coarse
// status plus run wall-clock timing folded from the log's RunStarted / terminal
// events. `startedAt` is set once (first RunStarted wins); `endedAt` accompanies
// a terminal status.
export interface RunProjection {
  status: RunState["status"];
  startedAt?: string;
  endedAt?: string;
}

function rowToState(row: WorkflowRunRecordRow): RunState {
  return {
    runId: row.id,
    kind: row.kind,
    tenantId: row.tenantId,
    principalId: row.principalId,
    status: row.status,
    ...(row.deploymentId !== null ? { deploymentId: row.deploymentId } : {}),
    ...(row.originConversationId !== null
      ? { originConversationId: row.originConversationId }
      : {}),
  };
}

export async function insertRunRecord(
  db: HubDb,
  args: {
    runId: string;
    deploymentId: string | null;
    kind: string;
    tenantId: string;
    principalId: string;
    input: unknown;
    originConversationId: string | null;
  },
): Promise<RunState> {
  await db.insert(workflowRunRecord).values({
    id: args.runId,
    deploymentId: args.deploymentId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: "running",
    input: args.input,
    originConversationId: args.originConversationId,
  });
  return {
    runId: args.runId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: "running",
    ...(args.deploymentId !== null ? { deploymentId: args.deploymentId } : {}),
    ...(args.originConversationId !== null
      ? { originConversationId: args.originConversationId }
      : {}),
  };
}

// Set a run's coarse run-level status (CL-2669). The single write primitive the
// optimistic resume, start-failure, and terminal-mark paths share.
export async function setRunStatus(
  db: HubDb,
  runId: string,
  status: RunState["status"],
): Promise<void> {
  await db
    .update(workflowRunRecord)
    .set({ status })
    .where(eq(workflowRunRecord.id, runId));
}

// Apply the run-level projection folded from the event log (CL-2669). Updates
// the coarse status, stamps `startedAt` when the log first reports it (never
// overwriting an existing value), and stamps `endedAt` alongside a terminal
// status.
export async function applyRunProjection(
  db: HubDb,
  runId: string,
  projection: RunProjection,
): Promise<void> {
  const patch: Partial<typeof workflowRunRecord.$inferInsert> = {
    status: projection.status,
  };
  if (projection.startedAt !== undefined) {
    patch.startedAt = new Date(projection.startedAt);
  }
  if (projection.endedAt !== undefined) {
    patch.endedAt = new Date(projection.endedAt);
  }
  await db
    .update(workflowRunRecord)
    .set(patch)
    .where(eq(workflowRunRecord.id, runId));
}

// Upsert the per-step projection for a run (CL-2727). Idempotent: the native
// fold replays the full log to the same per-step state on every pack, so each
// (runId, stepId) row is inserted once then updated in place. Called by the
// projection bridge; the log is the source of truth, this table is the index.
export async function upsertRunSteps(
  db: HubDb,
  runId: string,
  steps: readonly RunStepProjectionInput[],
): Promise<void> {
  if (steps.length === 0) return;
  await db
    .insert(workflowRunStep)
    .values(
      steps.map((s) => ({
        runId,
        stepId: s.stepId,
        phase: s.phase,
        attempts: s.attempts,
        startedAt: s.startedAt !== undefined ? new Date(s.startedAt) : null,
        endedAt: s.endedAt !== undefined ? new Date(s.endedAt) : null,
      })),
    )
    .onConflictDoUpdate({
      target: [workflowRunStep.runId, workflowRunStep.stepId],
      set: {
        phase: sql`excluded.phase`,
        attempts: sql`excluded.attempts`,
        startedAt: sql`excluded.started_at`,
        endedAt: sql`excluded.ended_at`,
      },
    });
}

export interface RunStepProjectionRow {
  stepId: string;
  phase: string;
  attempts: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

// Read a single run's per-step projection rows (CL-2727), ordered by start time
// then step id so an un-started step sorts last deterministically.
export async function listRunSteps(
  db: HubDb,
  runId: string,
): Promise<RunStepProjectionRow[]> {
  return db
    .select({
      stepId: workflowRunStep.stepId,
      phase: workflowRunStep.phase,
      attempts: workflowRunStep.attempts,
      startedAt: workflowRunStep.startedAt,
      endedAt: workflowRunStep.endedAt,
    })
    .from(workflowRunStep)
    .where(eq(workflowRunStep.runId, runId))
    .orderBy(workflowRunStep.startedAt, workflowRunStep.stepId);
}

export interface RunKindStats {
  kind: string;
  runs: {
    running: number;
    awaiting: number;
    completed: number;
    failed: number;
    total: number;
  };
  steps: {
    total: number;
    byPhase: Record<string, number>;
    // Mean wall-clock duration (ms) across steps that have both a start and an
    // end. Null when no step has completed yet.
    avgDurationMs: number | null;
  };
}

// Aggregate run + per-step stats by workflow kind (CL-2727), scoped to the
// caller's tenant chain + principal. Computed entirely from the per-step
// PROJECTION (`workflow_run_step`) plus the run index (`workflow_run_record`) —
// no git-log replay. Fetches the owned run rows and their projected steps, then
// folds in TS (per-principal volume is small); keeps the aggregation logic
// unit-testable rather than buried in SQL.
export async function getRunKindStats(
  db: HubDb,
  tenantIds: readonly string[],
  principalId: string,
  kind?: string,
): Promise<RunKindStats[]> {
  const runConditions = [
    inArray(workflowRunRecord.tenantId, [...tenantIds]),
    eq(workflowRunRecord.principalId, principalId),
    isNull(workflowRunRecord.deletedAt),
  ];
  if (kind !== undefined) runConditions.push(eq(workflowRunRecord.kind, kind));

  const runs = await db
    .select({
      id: workflowRunRecord.id,
      kind: workflowRunRecord.kind,
      status: workflowRunRecord.status,
    })
    .from(workflowRunRecord)
    .where(and(...runConditions));

  if (runs.length === 0) return [];

  const kindByRun = new Map(runs.map((r) => [r.id, r.kind]));
  const steps = await db
    .select({
      runId: workflowRunStep.runId,
      phase: workflowRunStep.phase,
      startedAt: workflowRunStep.startedAt,
      endedAt: workflowRunStep.endedAt,
    })
    .from(workflowRunStep)
    .where(inArray(workflowRunStep.runId, [...kindByRun.keys()]));

  const acc = new Map<
    string,
    RunKindStats & { durationSumMs: number; durationCount: number }
  >();
  const ensure = (
    k: string,
  ): RunKindStats & { durationSumMs: number; durationCount: number } => {
    let entry = acc.get(k);
    if (entry === undefined) {
      entry = {
        kind: k,
        runs: { running: 0, awaiting: 0, completed: 0, failed: 0, total: 0 },
        steps: { total: 0, byPhase: {}, avgDurationMs: null },
        durationSumMs: 0,
        durationCount: 0,
      };
      acc.set(k, entry);
    }
    return entry;
  };

  for (const run of runs) {
    const entry = ensure(run.kind);
    entry.runs.total += 1;
    entry.runs[run.status] += 1;
  }

  for (const step of steps) {
    const k = kindByRun.get(step.runId);
    if (k === undefined) continue;
    const entry = ensure(k);
    entry.steps.total += 1;
    entry.steps.byPhase[step.phase] =
      (entry.steps.byPhase[step.phase] ?? 0) + 1;
    if (step.startedAt !== null && step.endedAt !== null) {
      entry.durationSumMs += step.endedAt.getTime() - step.startedAt.getTime();
      entry.durationCount += 1;
    }
  }

  return [...acc.values()]
    .map(({ durationSumMs, durationCount, ...rest }) => ({
      ...rest,
      steps: {
        ...rest.steps,
        avgDurationMs: durationCount > 0 ? durationSumMs / durationCount : null,
      },
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// Mark an active run terminal (status:"failed"). Single source of truth for HOW
// a run becomes terminal — shared by the operator abort path
// (workflow-run-abort.ts) and the owner archive path (workflow-run-records.ts)
// so the terminal-mark shape never drifts. The failure REASON is no longer
// persisted (the log is the source of truth for run detail, CL-2669); callers
// log it. Tearing down the run's deployment is a SEPARATE concern the caller
// owns.
export async function markRunStopped(
  db: HubDb,
  state: RunState,
): Promise<void> {
  await setRunStatus(db, state.runId, "failed");
}

// Compare-and-set orphan-fail (CL-2727). Marks a run `failed` ONLY if it is
// STILL `running` at write time — the `status = 'running'` predicate is the CAS
// guard. This is the CL-2575 invariant made structural: a run that moved to
// `awaiting` (parked at a gate — resumable, never auto-failed), `completed`, or
// was already `failed` between the sweep's read and this write matches zero rows
// and is left untouched. Returns whether a row was flipped (for logging/tests).
export async function failRunIfStillRunning(
  db: HubDb,
  runId: string,
  endedAt: Date,
): Promise<boolean> {
  const flipped = await db
    .update(workflowRunRecord)
    .set({ status: "failed", endedAt })
    .where(
      and(
        eq(workflowRunRecord.id, runId),
        eq(workflowRunRecord.status, "running"),
        isNull(workflowRunRecord.deletedAt),
      ),
    )
    .returning({ id: workflowRunRecord.id });
  return flipped.length > 0;
}

// Soft-delete a run record (CL-2629): sets deletedAt so listRunRecords and
// loadRunRecord (both `deletedAt IS NULL`) stop returning it.
export async function softDeleteRunRecord(
  db: HubDb,
  runId: string,
): Promise<void> {
  await db
    .update(workflowRunRecord)
    .set({ deletedAt: new Date() })
    .where(eq(workflowRunRecord.id, runId));
}

export async function loadRunRecord(
  db: HubDb,
  runId: string,
): Promise<RunState | null> {
  const row = await db.query.workflowRunRecord.findFirst({
    where: and(
      eq(workflowRunRecord.id, runId),
      isNull(workflowRunRecord.deletedAt),
    ),
  });
  return row ? rowToState(row) : null;
}

export async function listRunRecords(
  db: HubDb,
  tenantIds: readonly string[],
  principalId: string,
  kind?: string,
  filters?: { originConversationId?: string },
): Promise<
  {
    runId: string;
    kind: string;
    status: string;
    createdAt: Date;
    originConversationId: string | null;
  }[]
> {
  const conditions = [
    inArray(workflowRunRecord.tenantId, [...tenantIds]),
    eq(workflowRunRecord.principalId, principalId),
    isNull(workflowRunRecord.deletedAt),
  ];
  if (kind !== undefined) conditions.push(eq(workflowRunRecord.kind, kind));
  if (filters?.originConversationId !== undefined) {
    conditions.push(
      eq(workflowRunRecord.originConversationId, filters.originConversationId),
    );
  }
  const rows = await db
    .select({
      runId: workflowRunRecord.id,
      kind: workflowRunRecord.kind,
      status: workflowRunRecord.status,
      createdAt: workflowRunRecord.createdAt,
      originConversationId: workflowRunRecord.originConversationId,
    })
    .from(workflowRunRecord)
    .where(and(...conditions))
    .orderBy(desc(workflowRunRecord.createdAt));
  return rows;
}
