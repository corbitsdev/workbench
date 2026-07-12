import type { Task } from "@workbench/shared";

import type { TaskExternalRefRecord, TaskPushStore } from "./store";

// In-memory TaskPushStore for package and hub tests. Mirrors the semantics the
// drizzle-backed store guarantees: ensurePendingRef is idempotent per
// (task, adapter) and markRefSynced stamps the external object.
export class InMemoryTaskPushStore implements TaskPushStore {
  private readonly tasks = new Map<string, Task>();
  private readonly refs = new Map<string, TaskExternalRefRecord>();
  private nextRefId = 1;

  putTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  async loadTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async findRef(
    taskId: string,
    adapterId: string,
  ): Promise<TaskExternalRefRecord | null> {
    return this.refs.get(`${taskId}:${adapterId}`) ?? null;
  }

  async ensurePendingRef(args: {
    taskId: string;
    adapterId: string;
    actorPrincipalId: string;
  }): Promise<TaskExternalRefRecord> {
    const key = `${args.taskId}:${args.adapterId}`;
    const existing = this.refs.get(key);
    if (existing) {
      return existing;
    }
    const ref: TaskExternalRefRecord = {
      id: `ref-${this.nextRefId++}`,
      taskId: args.taskId,
      adapterId: args.adapterId,
      externalId: null,
      externalUrl: null,
      syncState: "pending",
      actorPrincipalId: args.actorPrincipalId,
    };
    this.refs.set(key, ref);
    return ref;
  }

  async markRefSynced(args: {
    refId: string;
    externalId: string;
    externalUrl: string | null;
  }): Promise<void> {
    for (const [key, ref] of this.refs) {
      if (ref.id === args.refId) {
        this.refs.set(key, {
          ...ref,
          externalId: args.externalId,
          externalUrl: args.externalUrl,
          syncState: "synced",
        });
        return;
      }
    }
    throw new Error(`Ref not found: ${args.refId}`);
  }

  async listPendingRefs(limit: number): Promise<TaskExternalRefRecord[]> {
    const pending: TaskExternalRefRecord[] = [];
    for (const ref of this.refs.values()) {
      if (ref.syncState === "pending") {
        pending.push(ref);
        if (pending.length >= limit) {
          break;
        }
      }
    }
    return pending;
  }
}
