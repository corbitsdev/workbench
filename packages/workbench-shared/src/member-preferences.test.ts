import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { MemberPreferences, resolveAgentAutonomy } from "./index";

describe("MemberPreferences.agentAutonomy", () => {
  test("accepts prepare_only", () => {
    const parsed = MemberPreferences({ agentAutonomy: "prepare_only" });
    expect(parsed).toEqual({ agentAutonomy: "prepare_only" });
  });

  test("accepts execute_with_gates", () => {
    const parsed = MemberPreferences({ agentAutonomy: "execute_with_gates" });
    expect(parsed).toEqual({ agentAutonomy: "execute_with_gates" });
  });

  test("rejects an unknown autonomy value", () => {
    const parsed = MemberPreferences({ agentAutonomy: "full_auto" });
    expect(parsed instanceof type.errors).toBe(true);
  });
});

describe("resolveAgentAutonomy", () => {
  test("defaults to prepare_only when unset", () => {
    expect(resolveAgentAutonomy({})).toBe("prepare_only");
  });

  test("returns the stored value when set", () => {
    expect(resolveAgentAutonomy({ agentAutonomy: "execute_with_gates" })).toBe(
      "execute_with_gates",
    );
  });
});

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
