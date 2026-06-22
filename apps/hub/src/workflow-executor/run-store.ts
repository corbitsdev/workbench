import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { HubDb } from '../db';
import { workflowRunRecord, type WorkflowRunRecordRow } from '../db/schema';
import type { RunState, RunStore } from './executor';

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
  }
): Promise<RunState> {
  await db.insert(workflowRunRecord).values({
    id: args.runId,
    deploymentId: args.deploymentId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: 'running',
    currentStepId: null,
    input: args.input,
    outputs: {},
  });
  return {
    runId: args.runId,
    kind: args.kind,
    tenantId: args.tenantId,
    principalId: args.principalId,
    status: 'running',
    currentStepId: null,
    input: args.input,
    outputs: {},
  };
}

export async function loadRunRecord(db: HubDb, runId: string): Promise<RunState | null> {
  const row = await db.query.workflowRunRecord.findFirst({
    where: and(eq(workflowRunRecord.id, runId), isNull(workflowRunRecord.deletedAt)),
  });
  return row ? rowToState(row) : null;
}

export async function listRunRecords(
  db: HubDb,
  tenantIds: readonly string[],
  kind?: string
): Promise<Array<{ runId: string; kind: string; status: string; createdAt: Date }>> {
  const conditions = [
    inArray(workflowRunRecord.tenantId, [...tenantIds]),
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
