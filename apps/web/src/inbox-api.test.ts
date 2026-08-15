import { describe, expect, test } from "bun:test";
import { taskRefFromItem } from "./inbox-api";

describe("taskRefFromItem", () => {
  test("returns the task ref's id and label when present", () => {
    expect(
      taskRefFromItem({
        refs: [
          { kind: "run", id: "run_1" },
          { kind: "task", id: "task_1", label: "Incident Summarizer" },
        ],
      }),
    ).toEqual({ id: "task_1", label: "Incident Summarizer" });
  });

  test("returns the id alone when the ref has no label", () => {
    expect(taskRefFromItem({ refs: [{ kind: "task", id: "task_1" }] })).toEqual(
      { id: "task_1" },
    );
  });

  test("returns null when no task ref is present", () => {
    expect(taskRefFromItem({ refs: [{ kind: "run", id: "run_1" }] })).toBe(
      null,
    );
  });

  test("returns null when refs is absent", () => {
    expect(taskRefFromItem({})).toBe(null);
  });
});
