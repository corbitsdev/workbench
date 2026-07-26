import { describe, expect, test } from "bun:test";
import {
  assertGateStepsHaveStepUIEntry,
  assertStepUIKeysMatchStepIds,
} from "@workbench/shared";
import { workflow } from "./index";
import { STEP_UI } from "./step-ui";

describe("sumble-account-intel STEP_UI completeness", () => {
  test("every STEP_UI key names a real step id", () => {
    assertStepUIKeysMatchStepIds(STEP_UI, Object.keys(workflow.steps));
  });

  test("every awaitSignal (gate) step has a STEP_UI entry", () => {
    const gateStepIds = Object.entries(workflow.steps)
      .filter(([, primitive]) => primitive.kind === "awaitSignal")
      .map(([stepId]) => stepId);
    expect(gateStepIds).toEqual(["intake", "review"]);
    assertGateStepsHaveStepUIEntry(STEP_UI, gateStepIds);
  });

  test("review is a data-driven gate sourced from this workflow's own reviewGate step", () => {
    const review = STEP_UI.review;
    expect(review?.gateFromOutput).toBe(true);
    expect(review?.gateSourceStep).toBe("reviewGate");
  });

  test("intake is a static form gate collecting organizationDomain", () => {
    const intake = STEP_UI.intake;
    expect(intake?.input?.map((field) => field.name)).toEqual([
      "organizationDomain",
    ]);
  });
});
