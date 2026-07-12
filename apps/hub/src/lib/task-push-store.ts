import { and, eq } from "drizzle-orm";
import type { Task } from "@workbench/shared";
import type { TaskExternalRefRecord, TaskPushStore } from "@workbench/tasks";
import { task, taskExternalRef, type TaskExternalRefRow } from "../db/schema";
import { toApiTask } from "./task-store";
import type { HubDb } from "../db";

// The drizzle-backed adapter for the `@workbench/tasks` push service and
// reconciler. Keeps the domain package DB-agnostic (DI): the hub owns the
// tables, the domain owns the orchestration.

function toRecord(row: TaskExternalRefRow): TaskExternalRefRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    adapterId: row.adapterId,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    syncState: row.syncState,
    actorPrincipalId: row.actorPrincipalId,
  };
}

export function createDrizzleTaskPushStore(db: HubDb): TaskPushStore {
  async function loadTask(taskId: string): Promise<Task | null> {
    const [row] = await db
      .select()
      .from(task)
      .where(eq(task.id, taskId))
      .limit(1);
    if (!row) return null;
    const refs = await db
      .select()
      .from(taskExternalRef)
      .where(eq(taskExternalRef.taskId, taskId));
    return toApiTask(row, refs);
  }

  async function findRef(
    taskId: string,
    adapterId: string,
  ): Promise<TaskExternalRefRecord | null> {
    const [row] = await db
      .select()
      .from(taskExternalRef)
      .where(
        and(
          eq(taskExternalRef.taskId, taskId),
          eq(taskExternalRef.adapterId, adapterId),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async function ensurePendingRef(args: {
    taskId: string;
    adapterId: string;
    actorPrincipalId: string;
  }): Promise<TaskExternalRefRecord> {
    // The unique (taskId, adapterId) constraint makes this idempotent under a
    // race: a concurrent insert no-ops and we re-read the winner.
    await db
      .insert(taskExternalRef)
      .values({
        taskId: args.taskId,
        adapterId: args.adapterId,
        actorPrincipalId: args.actorPrincipalId,
      })
      .onConflictDoNothing({
        target: [taskExternalRef.taskId, taskExternalRef.adapterId],
      });
    const existing = await findRef(args.taskId, args.adapterId);
    if (!existing) {
      throw new Error(
        `Failed to ensure task ref for ${args.taskId}/${args.adapterId}`,
      );
    }
    return existing;
  }

  async function markRefSynced(args: {
    refId: string;
    externalId: string;
    externalUrl: string | null;
  }): Promise<void> {
    await db
      .update(taskExternalRef)
      .set({
        externalId: args.externalId,
        externalUrl: args.externalUrl,
        syncState: "synced",
        lastSyncedAt: new Date(),
      })
      .where(eq(taskExternalRef.id, args.refId));
  }

  async function listPendingRefs(
    limit: number,
  ): Promise<TaskExternalRefRecord[]> {
    const rows = await db
      .select()
      .from(taskExternalRef)
      .where(eq(taskExternalRef.syncState, "pending"))
      .limit(limit);
    return rows.map(toRecord);
  }

  return {
    loadTask,
    findRef,
    ensurePendingRef,
    markRefSynced,
    listPendingRefs,
  };
}
