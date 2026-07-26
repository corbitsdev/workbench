import { describe, expect, test } from "bun:test";
import {
  assertGateStepsHaveStepUIEntry,
  assertStepUIKeysMatchStepIds,
} from "@workbench/shared";
import { workflow } from "./index";
import { STEP_UI } from "./step-ui";

describe("multi-source-collateral STEP_UI completeness", () => {
  test("every STEP_UI key names a real step id", () => {
    assertStepUIKeysMatchStepIds(STEP_UI, Object.keys(workflow.steps));
  });

  test("every awaitSignal (gate) step has a STEP_UI entry", () => {
    const gateStepIds = Object.entries(workflow.steps)
      .filter(([, primitive]) => primitive.kind === "awaitSignal")
      .map(([stepId]) => stepId);
    expect(gateStepIds).toEqual([
      "sources",
      "options",
      "review",
      "review-final",
    ]);
    assertGateStepsHaveStepUIEntry(STEP_UI, gateStepIds);
  });

  test("every gate is data-driven, sourced from this workflow's own gate-builder tool", () => {
    expect(STEP_UI.sources?.gateFromOutput).toBe(true);
    expect(STEP_UI.sources?.gateSourceStep).toBe("prepareSourcesGate");
    expect(STEP_UI.options?.gateFromOutput).toBe(true);
    expect(STEP_UI.options?.gateSourceStep).toBe("prepareOptionsGate");
    expect(STEP_UI.review?.gateFromOutput).toBe(true);
    expect(STEP_UI.review?.gateSourceStep).toBe("prepareReviewGate");
    expect(STEP_UI["review-final"]?.gateFromOutput).toBe(true);
    expect(STEP_UI["review-final"]?.gateSourceStep).toBe(
      "prepareReviewFinalGate",
    );
  });
});
