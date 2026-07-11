import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  Task,
  TaskExternalRef,
  TaskLink,
  TaskStatus,
} from "@workbench/shared";
import {
  task,
  taskExternalRef,
  type TaskExternalRefRow,
  type TaskRow,
} from "../db/schema";
import type { HubDb } from "../db";

// Owner-scoped persistence for native tasks. Every read and write is bound to
// (tenantId, ownerPrincipalId) so a member can never see or mutate another
// member's task — the same isolation guarantee as the schedules store.

const DEFAULT_TASK_LIMIT = 100;

export type CreateTaskInput = {
  tenantId: string;
  ownerPrincipalId: string;
  createdByPrincipalId: string;
  title: string;
  body?: string;
  source: Task["source"];
  sourceRef?: string;
  due?: string;
  links?: TaskLink[];
};

export type UpdateTaskInput = {
  tenantId: string;
  ownerPrincipalId: string;
  id: string;
  title?: string;
  body?: string;
  status?: TaskStatus;
  due?: string | null;
};

function toExternalRef(row: TaskExternalRefRow): TaskExternalRef {
  const ref: TaskExternalRef = {
    adapterId: row.adapterId,
    externalId: row.externalId ?? "",
    syncState: row.syncState,
  };
  if (row.externalUrl !== null) ref.externalUrl = row.externalUrl;
  if (row.lastSyncedAt !== null) {
    ref.lastSyncedAt = row.lastSyncedAt.toISOString();
  }
  return ref;
}

export function toApiTask(row: TaskRow, refs: TaskExternalRefRow[]): Task {
  const result: Task = {
    id: row.id,
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    createdByPrincipalId: row.createdByPrincipalId,
    title: row.title,
    status: row.status,
    source: row.source,
    links: row.links,
    // Only refs with an established external object are user-visible; a pending
    // ref that has never linked stays server-side (the "sending…" affordance is
    // driven separately), never surfaced as an error.
    externalRefs: refs
      .filter((ref) => ref.externalId !== null)
      .map(toExternalRef),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.body !== null) result.body = row.body;
  if (row.sourceRef !== null) result.sourceRef = row.sourceRef;
  if (row.due !== null) result.due = row.due.toISOString();
  return result;
}

async function loadRefsByTaskIds(
  db: HubDb,
  taskIds: string[],
): Promise<Map<string, TaskExternalRefRow[]>> {
  const byTask = new Map<string, TaskExternalRefRow[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select()
    .from(taskExternalRef)
    .where(inArray(taskExternalRef.taskId, taskIds));
  for (const row of rows) {
    const list = byTask.get(row.taskId) ?? [];
    list.push(row);
    byTask.set(row.taskId, list);
  }
  return byTask;
}

export async function listOwnerTasks(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    statuses?: TaskStatus[];
    limit?: number;
  },
): Promise<Task[]> {
  const conditions = [
    eq(task.tenantId, args.tenantId),
    eq(task.ownerPrincipalId, args.ownerPrincipalId),
  ];
  if (args.statuses !== undefined && args.statuses.length > 0) {
    conditions.push(inArray(task.status, args.statuses));
  }
  const rows = await db
    .select()
    .from(task)
    .where(and(...conditions))
    .orderBy(desc(task.createdAt))
    .limit(args.limit ?? DEFAULT_TASK_LIMIT);
  const refs = await loadRefsByTaskIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toApiTask(row, refs.get(row.id) ?? []));
}

export async function getOwnerTask(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; id: string },
): Promise<Task | null> {
  const [row] = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.id, args.id),
        eq(task.tenantId, args.tenantId),
        eq(task.ownerPrincipalId, args.ownerPrincipalId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refs = await loadRefsByTaskIds(db, [row.id]);
  return toApiTask(row, refs.get(row.id) ?? []);
}

export async function createOwnerTask(
  db: HubDb,
  input: CreateTaskInput,
): Promise<Task> {
  const values: typeof task.$inferInsert = {
    tenantId: input.tenantId,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    title: input.title,
    source: input.source,
    links: input.links ?? [],
  };
  if (input.body !== undefined) values.body = input.body;
  if (input.sourceRef !== undefined) values.sourceRef = input.sourceRef;
  if (input.due !== undefined) values.due = new Date(input.due);
  const [row] = await db.insert(task).values(values).returning();
  if (!row) throw new Error("Failed to create task");
  return toApiTask(row, []);
}

export async function updateOwnerTask(
  db: HubDb,
  input: UpdateTaskInput,
): Promise<Task | null> {
  const set: Partial<typeof task.$inferInsert> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.body !== undefined) set.body = input.body;
  if (input.status !== undefined) set.status = input.status;
  if (input.due !== undefined) {
    set.due = input.due === null ? null : new Date(input.due);
  }
  const [row] = await db
    .update(task)
    .set(set)
    .where(
      and(
        eq(task.id, input.id),
        eq(task.tenantId, input.tenantId),
        eq(task.ownerPrincipalId, input.ownerPrincipalId),
      ),
    )
    .returning();
  if (!row) return null;
  const refs = await loadRefsByTaskIds(db, [row.id]);
  return toApiTask(row, refs.get(row.id) ?? []);
}
