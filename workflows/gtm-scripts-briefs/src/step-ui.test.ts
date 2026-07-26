import { describe, expect, test } from "bun:test";
import { INTAKE_FIELDS, STEP_UI, INTAKE_SIGNAL } from "./step-ui";

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
