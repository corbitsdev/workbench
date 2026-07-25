import { describe, expect, test } from "bun:test";
import {
  assertGateStepsHaveStepUIEntry,
  assertStepUIKeysMatchStepIds,
} from "@workbench/shared";
import { workflow } from "./index";
import { STEP_UI } from "./step-ui";

function gateStepIds(): string[] {
  return Object.entries(workflow.steps)
    .filter(([, step]) => step.kind === "awaitSignal")
    .map(([stepId]) => stepId);
}

describe("STEP_UI keys match real step ids", () => {
  test("every STEP_UI key names a step the workflow actually defines", () => {
    expect(() =>
      assertStepUIKeysMatchStepIds(STEP_UI, Object.keys(workflow.steps)),
    ).not.toThrow();
  });

  test("catches a renamed/orphaned entry", () => {
    expect(() =>
      assertStepUIKeysMatchStepIds(
        { "renamed-step": STEP_UI.intake! },
        Object.keys(workflow.steps),
      ),
    ).toThrow(/unknown step id/);
  });
});

describe("every gate step has a STEP_UI entry", () => {
  test("no awaitSignal step is missing its STEP_UI entry", () => {
    expect(() =>
      assertGateStepsHaveStepUIEntry(STEP_UI, gateStepIds()),
    ).not.toThrow();
  });

  test("catches a gate step with no STEP_UI entry", () => {
    expect(() => assertGateStepsHaveStepUIEntry({}, gateStepIds())).toThrow(
      /missing entries for gate step/,
    );
  });
});
