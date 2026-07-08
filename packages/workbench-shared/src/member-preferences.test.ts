import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { MemberPreferences } from "./index";

describe("MemberPreferences.favoriteWorkflows", () => {
  test("accepts an array of workflow kinds", () => {
    const parsed = MemberPreferences({
      favoriteWorkflows: ["attio-task-agent", "last30days"],
    });
    expect(parsed).toEqual({
      favoriteWorkflows: ["attio-task-agent", "last30days"],
    });
  });

  test("accepts an empty favorites array", () => {
    const parsed = MemberPreferences({ favoriteWorkflows: [] });
    expect(parsed).toEqual({ favoriteWorkflows: [] });
  });

  test("rejects a non-array favoriteWorkflows value", () => {
    const parsed = MemberPreferences({ favoriteWorkflows: "attio-task-agent" });
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("rejects non-string elements in favoriteWorkflows", () => {
    const parsed = MemberPreferences({ favoriteWorkflows: ["ok", 3] });
    expect(parsed instanceof type.errors).toBe(true);
  });
});
