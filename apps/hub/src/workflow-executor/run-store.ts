import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { HubDb } from "../db";
import { workflowRunRecord, type WorkflowRunRecordRow } from "../db/schema";
import type { RunState, RunStore } from "./executor";

function rowToState(row: WorkflowRunRecordRow): RunState {
  return {
    runId: row.id,
    kind: row.kind,
    tenantId: row.tenantId,
    principalId: row.principalId,
    status: row.status,
    currentStepId: row.currentStepId,
    input: row.input,
    outputs: row.outputs,
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.deploymentId !== null ? { deploymentId: row.deploymentId } : {}),
  };
}

// A RunStore backed by the workflow_run_record row. save() upserts the
// execution columns; the row is created at /start, so save() only updates.
export function createRunStore(db: HubDb): RunStore {
  return {
    async save(state: RunState) {
      await db
        .update(workflowRunRecord)
        .set({
          status: state.status,
          currentStepId: state.currentStepId,
          outputs: state.outputs,
          error: state.error ?? null,
        })
        .where(eq(workflowRunRecord.id, state.runId));
    },
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
  },
): Promise<RunState> {
  await db.insert(workflowRunRecord).values({
    id: args.runId,
    deploymentId: args.deploymentId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: "running",
    currentStepId: null,
    input: args.input,
    outputs: {},
  });
  return {
    runId: args.runId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: "running",
    currentStepId: null,
    input: args.input,
    outputs: {},
  };
}

// Mark an active run terminal (status:"failed") with a reason. Single source of
// truth for HOW a run becomes terminal — shared by the operator abort path
// (workflow-run-abort.ts) and the owner archive path (workflow-run-records.ts)
// so the terminal-mark shape never drifts between them. Tearing down the run's
// deployment is a SEPARATE concern the caller owns: abort defers to the
// boot-reconciler, archive reclaims immediately (CL-2629).
export async function markRunStopped(
  db: HubDb,
  state: RunState,
  error: string,
): Promise<void> {
  await createRunStore(db).save({ ...state, status: "failed", error });
}

// Soft-delete a run record (CL-2629): sets deletedAt so listRunRecords and
// loadRunRecord (both `deletedAt IS NULL`) stop returning it. Used by the
// user-facing archive route to drop a run from the sidebar.
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
): Promise<{ runId: string; kind: string; status: string; createdAt: Date }[]> {
  const conditions = [
    inArray(workflowRunRecord.tenantId, [...tenantIds]),
    eq(workflowRunRecord.principalId, principalId),
    isNull(workflowRunRecord.deletedAt),
  ];
  if (kind !== undefined) conditions.push(eq(workflowRunRecord.kind, kind));
  const rows = await db
    .select({
      runId: workflowRunRecord.id,
      kind: workflowRunRecord.kind,
      status: workflowRunRecord.status,
      createdAt: workflowRunRecord.createdAt,
    })
    .from(workflowRunRecord)
    .where(and(...conditions))
    .orderBy(desc(workflowRunRecord.createdAt));
  return rows;
}
