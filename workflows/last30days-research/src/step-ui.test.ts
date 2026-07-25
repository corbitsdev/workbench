import { describe, expect, test } from "bun:test";
import { assertStepUIKeysMatchStepIds } from "@workbench/shared";
import { workflow } from "./index";
import { STEP_UI } from "./step-ui";

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
