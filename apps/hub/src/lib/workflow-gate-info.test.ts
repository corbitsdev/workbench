import { describe, expect, it } from "bun:test";
import {
  deriveEntryStepRequiredTriggerFields,
  deriveWorkflowGateInfo,
} from "./workflow-gate-info";

function def(steps: Record<string, { kind?: string; name?: string }>): unknown {
  return { id: "wf", steps, stepOrder: Object.keys(steps) };
}

describe("deriveWorkflowGateInfo", () => {
  it("flags a workflow whose only gate is an intake awaitSignal", () => {
    const info = deriveWorkflowGateInfo(
      def({
        intake: { kind: "awaitSignal", name: "intake" },
        work: { kind: "step" },
      }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 1 });
  });

  it("counts every awaitSignal gate and detects a non-intake first gate", () => {
    const info = deriveWorkflowGateInfo(
      def({
        config: { kind: "awaitSignal", name: "config" },
        run: { kind: "step" },
        decision: { kind: "awaitSignal", name: "decision" },
      }),
    );
    expect(info).toEqual({ requiresIntake: false, humanGateCount: 2 });
  });

  it("counts multiple gates including an intake one", () => {
    const info = deriveWorkflowGateInfo(
      def({
        intake: { kind: "awaitSignal", name: "intake" },
        review: { kind: "awaitSignal", name: "review" },
      }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 2 });
  });

  it("reports zero gates for a fully deterministic workflow", () => {
    const info = deriveWorkflowGateInfo(
      def({ emit: { kind: "step" }, save: { kind: "step" } }),
    );
    expect(info).toEqual({ requiresIntake: false, humanGateCount: 0 });
  });

  it("falls back to the step id when an awaitSignal has no name", () => {
    const info = deriveWorkflowGateInfo(
      def({ intake: { kind: "awaitSignal" } }),
    );
    expect(info).toEqual({ requiresIntake: true, humanGateCount: 1 });
  });

  it("returns zero gates for a malformed definition rather than throwing", () => {
    expect(deriveWorkflowGateInfo(null)).toEqual({
      requiresIntake: false,
      humanGateCount: 0,
    });
    expect(deriveWorkflowGateInfo({ steps: "nope" })).toEqual({
      requiresIntake: false,
      humanGateCount: 0,
    });
  });
});

describe("deriveEntryStepRequiredTriggerFields", () => {
  function stepDef(steps: Record<string, unknown>): unknown {
    return { id: "wf", steps, stepOrder: Object.keys(steps) };
  }

  it("extracts the trigger-payload keys named in the entry step's arg map (granola-call's noteId)", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        fetch: {
          kind: "step",
          input: { from: "trigger.payload" },
          agent: {
            tags: { "workbench.argMap": '{"noteId":{"from":"noteId"}}' },
          },
        },
      }),
    );
    expect(fields).toEqual(["noteId"]);
  });

  it("returns no required fields for an entry step with no arg map (prospect-engine's initBudget)", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        initBudget: {
          kind: "step",
          input: { from: "trigger.payload" },
          agent: { tags: { "workbench.argMap": "{}" } },
        },
      }),
    );
    expect(fields).toEqual([]);
  });

  it("returns no required fields when the entry is an intake gate, not a direct trigger read", () => {
    const fields = deriveEntryStepRequiredTriggerFields(
      stepDef({
        intake: { kind: "awaitSignal", name: "intake" },
        work: { kind: "step" },
      }),
    );
    expect(fields).toEqual([]);
  });

  it("returns no required fields for a malformed definition rather than throwing", () => {
    expect(deriveEntryStepRequiredTriggerFields(null)).toEqual([]);
    expect(deriveEntryStepRequiredTriggerFields({})).toEqual([]);
  });
});
