import { describe, expect, test } from "bun:test";

import { isWorkingTask, workingTasks } from "./working-task";
import type { Task } from "./api";
import type { WorkingTask } from "./working-task";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    definitionId: "def_1",
    agentName: "Researcher",
    prompt: "Summarize the thread",
    modelPreference: null,
    status: "running",
    runId: "run_1",
    runIds: ["run_1"],
    stepCount: 1,
    resultMailId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

/** Same fixture, narrowed to a status `workingTasks` always returns —
 * lets a test assert against `workingTasks`'s own `WorkingTask` return
 * type without widening it back to the full `Task` status union. */
function workingTask(overrides: Partial<Task> = {}): WorkingTask {
  return task({ status: "running", ...overrides }) as WorkingTask;
}

describe("isWorkingTask", () => {
  test("queued, running, and needs-you are working", () => {
    expect(isWorkingTask("queued")).toBe(true);
    expect(isWorkingTask("running")).toBe(true);
    expect(isWorkingTask("needs-you")).toBe(true);
  });

  test("done and failed are not working — they've moved to the Inbox", () => {
    expect(isWorkingTask("done")).toBe(false);
    expect(isWorkingTask("failed")).toBe(false);
  });
});

describe("workingTasks", () => {
  test("keeps only in-progress tasks, carrying their own agentName", () => {
    const running = workingTask({ id: "tsk_running", agentName: "Researcher" });
    const tasks = [
      running,
      task({ id: "tsk_done", status: "done" }),
      task({ id: "tsk_failed", status: "failed" }),
    ];
    expect(workingTasks(tasks)).toEqual([running]);
  });

  test("a planner-created agent's name comes from the task record, not a definitions listing", () => {
    // Planner-created agents (myra-task-*) are excluded from
    // listTenantInvitableDefinitions (CL-6051) — the row's name has to
    // come from the task itself, never from a definitions lookup.
    const plannerTask = workingTask({
      definitionId: "wfd_myra_task_1",
      agentName: "Incident triage",
    });
    expect(workingTasks([plannerTask])).toEqual([plannerTask]);
  });

  test("returns nothing for an all-terminal task list", () => {
    const tasks = [task({ status: "done" }), task({ status: "failed" })];
    expect(workingTasks(tasks)).toEqual([]);
  });
});
