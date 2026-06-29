import { describe, expect, test } from "bun:test";
import {
  StepToolNotRegisteredError,
  assertStepToolAvailable,
} from "./step-tool-harness";

// GOAL B (CL-2503): a step that declares a tool which never loaded (the
// stale/missing package-registry tarball case) must fail with a clear, named,
// actionable error — not a generic step failure.
describe("assertStepToolAvailable", () => {
  test("passes silently when the declared tool loaded", () => {
    expect(() =>
      assertStepToolAvailable(
        "@workbench/tools-last30days/core:last30days_ground_queries",
        new Set([
          "@workbench/tools-last30days/core:last30days_ground_queries",
          "other_tool",
        ]),
      ),
    ).not.toThrow();
  });

  test("throws a named, actionable error naming the unresolved tool", () => {
    let thrown: unknown;
    try {
      assertStepToolAvailable(
        "@workbench/tools-last30days/core:last30days_ground_queries",
        new Set(["some_other_tool"]),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepToolNotRegisteredError);
    const error = thrown as StepToolNotRegisteredError;
    expect(error.toolName).toBe(
      "@workbench/tools-last30days/core:last30days_ground_queries",
    );
    expect(error.message).toContain(
      'tool "@workbench/tools-last30days/core:last30days_ground_queries" is not registered/available for this deployment',
    );
    // The loaded set is surfaced so an operator can see what DID link up.
    expect(error.message).toContain("some_other_tool");
    expect(error.loadedTools).toEqual(["some_other_tool"]);
    // An Error subclass carries a stack so the workflow-child's Sentry sink
    // captures it via captureException (GOAL A).
    expect(typeof error.stack).toBe("string");
  });

  test("reports 'none' when no tools loaded at all (stale tarball)", () => {
    expect(() =>
      assertStepToolAvailable("missing_tool", new Set<string>()),
    ).toThrow(/loaded tools: none/);
  });
});
