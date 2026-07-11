import type { Task } from "@workbench/shared";

// The persistence port the push service and reconciler depend on. The hub owns
// the drizzle-backed implementation over the `task` / `task_external_ref`
// tables; the domain package stays app- and DB-agnostic (DI, per AGENTS.md).

// A ref row as the push service sees it — with the internal id and attribution
// the boundary `TaskExternalRef` shape omits. `externalId` is null until the
// first successful external write.
export type TaskExternalRefRecord = {
  id: string;
  taskId: string;
  adapterId: string;
  externalId: string | null;
  externalUrl: string | null;
  syncState: "pending" | "synced" | "detached";
  actorPrincipalId: string;
};

export interface TaskPushStore {
  loadTask(taskId: string): Promise<Task | null>;
  findRef(
    taskId: string,
    adapterId: string,
  ): Promise<TaskExternalRefRecord | null>;
  // Idempotent: returns the existing (task, adapter) ref, or inserts a fresh
  // `pending` one. The unique (taskId, adapterId) constraint backstops a race.
  ensurePendingRef(args: {
    taskId: string;
    adapterId: string;
    actorPrincipalId: string;
  }): Promise<TaskExternalRefRecord>;
  markRefSynced(args: {
    refId: string;
    externalId: string;
    externalUrl: string | null;
  }): Promise<void>;
  listPendingRefs(limit: number): Promise<TaskExternalRefRecord[]>;
}
