import { describe, expect, test } from "bun:test";

import { isWorkingTask, toWorkingTaskViews } from "./working-task";
import type { Task } from "./api";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    definitionId: "def_1",
    prompt: "Summarize the thread",
    modelPreference: null,
    status: "running",
    runId: "run_1",
    resultMailId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
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

describe("toWorkingTaskViews", () => {
  test("keeps only in-progress tasks and resolves their display name", () => {
    const running = task({
      id: "tsk_running",
      status: "running",
      definitionId: "def_1",
    });
    const tasks = [
      running,
      task({ id: "tsk_done", status: "done", definitionId: "def_1" }),
      task({ id: "tsk_failed", status: "failed", definitionId: "def_1" }),
    ];
    const names = new Map([["def_1", "Researcher"]]);
    expect(toWorkingTaskViews(tasks, names)).toEqual([
      { task: running, displayName: "Researcher" },
    ]);
  });

  test("falls back to the definitionId when the name isn't in the map", () => {
    const unlisted = task({ definitionId: "def_unlisted" });
    const tasks = [unlisted];
    expect(toWorkingTaskViews(tasks, new Map())).toEqual([
      { task: unlisted, displayName: "def_unlisted" },
    ]);
  });

  test("returns nothing for an all-terminal task list", () => {
    const tasks = [task({ status: "done" }), task({ status: "failed" })];
    expect(toWorkingTaskViews(tasks, new Map())).toEqual([]);
  });
});
