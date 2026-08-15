// The "Working" group's view model: which task statuses still belong in
// the Spaces band, narrowed at the type level so a terminal-status task
// can never reach `WorkingTaskRow` — see `working-task.type-guard.ts`
// for the compile-time regression that enforces it.
import type { Task, TaskStatus } from "./api";

export type WorkingTaskStatus = "queued" | "running" | "needs-you";

export type WorkingTask = Omit<Task, "status"> & {
  readonly status: WorkingTaskStatus;
};

const WORKING_STATUSES: ReadonlySet<WorkingTaskStatus> = new Set([
  "queued",
  "running",
  "needs-you",
]);

export function isWorkingTask(status: TaskStatus): status is WorkingTaskStatus {
  return WORKING_STATUSES.has(status as WorkingTaskStatus);
}

/**
 * The signed-in user's in-progress tasks. `done`/`failed` are terminal —
 * that task's result has moved to the Inbox, so it drops out of this list
 * on the Spaces band's next refresh once it completes: the band refetches
 * on bench change (`useBenchActivity` in `apps/web`), not on a push from
 * the task itself, so "leaves the group" means "gone by the next refetch,"
 * not an instant live update.
 */
export function workingTasks(tasks: readonly Task[]): readonly WorkingTask[] {
  return tasks.filter((task): task is WorkingTask =>
    isWorkingTask(task.status),
  );
}
