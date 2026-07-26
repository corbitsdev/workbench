import { describe, expect, test } from "bun:test";
import { INTAKE_FIELDS, INTAKE_FORM_FIELDS } from "./intake-fields";

describe("gamma-presentation-creator INTAKE_FORM_FIELDS -> INTAKE_FIELDS mapping (CL-4538)", () => {
  test("gammaId's placeholder models the value to type, not an instruction", () => {
    const gammaId = INTAKE_FORM_FIELDS.find((field) => field.name === "gammaId");
    expect(gammaId?.placeholder).not.toMatch(/find|admin page/i);
    expect(gammaId?.placeholder).toBe("e.g. abc123XYZ");
  });

  test("the where-to-find-it guidance moved to help text and survives the mapping", () => {
    const gammaId = INTAKE_FIELDS.find((field) => field.name === "gammaId");
    expect(gammaId?.help).toMatch(/Gamma Templates admin page/);
  });
});
