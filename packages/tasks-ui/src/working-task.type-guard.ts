// Compile-time guard, enforced by `tsc --noEmit` (mirrors
// `apps/web/test/page-type-drift.ts`'s pattern): a terminal-status task
// must never satisfy `WorkingTask`, or reach `WorkingTaskRow`'s props. The
// Working group's exclusion of completed/failed tasks is a type-level
// guarantee, not just `workingTasks`' runtime filter — if either drifts,
// the assignments below stop compiling.
import type { WorkingTask } from "./working-task";
import { WorkingTaskRow } from "./working-task-row";

declare const doneStatus: "done";
// @ts-expect-error a terminal status is not a WorkingTaskStatus
const _rejectedStatus: WorkingTask["status"] = doneStatus;

declare const terminalTask: {
  readonly status: "failed";
  readonly createdAt: string;
  readonly agentName: string;
};
const _rejectedProps: Parameters<typeof WorkingTaskRow>[0] = {
  // @ts-expect-error WorkingTaskRow must reject a terminal-status task
  task: terminalTask,
  onSelect: () => undefined,
};
