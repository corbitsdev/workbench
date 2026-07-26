import { describe, expect, test } from "bun:test";
import {
  assertGateStepsHaveStepUIEntry,
  assertStepUIKeysMatchStepIds,
} from "@workbench/shared";
import { workflow } from "./index";
import { INTAKE_FIELDS, STEP_UI, INTAKE_SIGNAL } from "./step-ui";

describe("gtm-scripts-briefs STEP_UI completeness", () => {
  test("every STEP_UI key names a real step id", () => {
    assertStepUIKeysMatchStepIds(STEP_UI, Object.keys(workflow.steps));
  });

  test("every awaitSignal (gate) step has a STEP_UI entry", () => {
    const gateStepIds = Object.entries(workflow.steps)
      .filter(([, primitive]) => primitive.kind === "awaitSignal")
      .map(([stepId]) => stepId);
    expect(gateStepIds).toEqual(["intake"]);
    assertGateStepsHaveStepUIEntry(STEP_UI, gateStepIds);
  });

  test("write, persist-prepare, and persist each carry a dock title", () => {
    expect(STEP_UI.write?.title).toBe("Write the deliverable");
    expect(STEP_UI["persist-prepare"]?.title).toBe(
      "Shape the deliverable for saving",
    );
    expect(STEP_UI.persist?.title).toBe("Save to your workbench");
  });
});

describe("gtm-scripts-briefs INTAKE_FORM_FIELDS -> INTAKE_FIELDS mapping (CL-4538)", () => {
  test("the dock form's declared defaultValue survives into the schedule fields", () => {
    const dockFields = STEP_UI[INTAKE_SIGNAL]?.input ?? [];
    const dockDays = dockFields.find((field) => field.name === "days");
    if (dockDays?.kind !== "number") {
      throw new Error("expected the dock form to declare a numeric days field");
    }
    expect(dockDays.defaultValue).toBe(30);

    const scheduleDays = INTAKE_FIELDS.find((field) => field.name === "days");
    expect(scheduleDays?.defaultValue).toBe(30);
  });

  test("the dock form's declared bounds survive into the schedule fields", () => {
    const scheduleDays = INTAKE_FIELDS.find((field) => field.name === "days");
    expect(scheduleDays?.min).toBe(1);
    expect(scheduleDays?.step).toBe(1);
  });
});
