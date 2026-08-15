// The "Working" group's presentation logic: which task statuses still
// belong on screen, and how a task's bare `definitionId` (see
// `packages/tasks/src/routes.ts`'s `taskView`) resolves to the display
// name a row shows. Pure so both are testable without rendering.
import type { Task, TaskStatus } from "./api";

/**
 * Statuses that keep a task in the "Working" group. `done`/`failed` are
 * terminal — that task's result already lives in the Inbox, so it leaves
 * this group the instant it lands there (see `taskView`/`resultMailId`).
 * `needs-you` is included even though `@corbits/tasks` never writes it
 * today (see `packages/tasks/src/schema.ts`) — the group is ready for the
 * day a mid-task approval sets it.
 */
const WORKING_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "running",
  "needs-you",
]);

export function isWorkingTask(status: TaskStatus): boolean {
  return WORKING_STATUSES.has(status);
}

export type WorkingTaskView = {
  readonly task: Task;
  readonly displayName: string;
};

/**
 * The signed-in user's in-progress tasks, each resolved to a display name.
 * Not creator-scoped here — `GET /tasks` already returns only the
 * requesting principal's own tasks, so every task passed in is already
 * "mine" (`packages/tasks/src/routes.ts`). A `definitionId` with no match
 * in `definitionNamesById` (a deleted or unlisted definition) falls back to
 * the id itself rather than disappearing the row.
 */
export function toWorkingTaskViews(
  tasks: readonly Task[],
  definitionNamesById: ReadonlyMap<string, string>,
): readonly WorkingTaskView[] {
  return tasks
    .filter((task) => isWorkingTask(task.status))
    .map((task) => ({
      task,
      displayName:
        definitionNamesById.get(task.definitionId) ?? task.definitionId,
    }));
}
