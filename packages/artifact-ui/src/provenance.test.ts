import { describe, expect, test } from "bun:test";

import { workflowRunIdFromSource } from "./provenance";

describe("workflowRunIdFromSource", () => {
  test("returns the run id for a workflow-origin source", () => {
    expect(
      workflowRunIdFromSource({ origin: "workflow", runId: "run_1" }),
    ).toBe("run_1");
  });

  test("is null for a non-workflow origin", () => {
    expect(workflowRunIdFromSource({ origin: "manual" })).toBeNull();
    expect(
      workflowRunIdFromSource({ origin: "agent", runId: "run_1" }),
    ).toBeNull();
  });

  test("is null when workflow origin has no usable runId", () => {
    expect(workflowRunIdFromSource({ origin: "workflow" })).toBeNull();
    expect(
      workflowRunIdFromSource({ origin: "workflow", runId: "" }),
    ).toBeNull();
    expect(
      workflowRunIdFromSource({ origin: "workflow", runId: 42 }),
    ).toBeNull();
  });

  test("is null for a missing source", () => {
    expect(workflowRunIdFromSource(null)).toBeNull();
    expect(workflowRunIdFromSource(undefined)).toBeNull();
  });
});
