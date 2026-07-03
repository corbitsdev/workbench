import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { HubDb } from "../db";
import { workflowRunRecord, type WorkflowRunRecordRow } from "../db/schema";

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
