/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { ScheduleFieldInputKindSchema } from "@workbench/shared";
import { EmbeddedIntakeFieldSchema } from "./workflow-gate-info";

// The schedule-field input-kind union is hand-duplicated: `@workbench/shared`
// owns the canonical list, and the embedded intake-field schema re-declares it
// on the delivery path that `build-workflow-defs.ts` parses through. Widening
// only one leaves a declared kind unparseable, so the divergence must fail here.
function unionMembers(expression: string): string[] {
  return expression
    .split("|")
    .map((member) => member.trim().replace(/^"|"$/g, ""))
    .filter((member) => member !== "undefined")
    .sort();
}

describe("schedule-field input-kind union parity", () => {
  const canonical = unionMembers(ScheduleFieldInputKindSchema.expression);

  it("has a non-trivial canonical union", () => {
    expect(canonical).toContain("select-multi");
  });

  it("matches EmbeddedIntakeFieldSchema.inputHint exactly", () => {
    expect(
      unionMembers(EmbeddedIntakeFieldSchema.get("inputHint").expression),
    ).toEqual(canonical);
  });

  it("matches EmbeddedIntakeFieldSchema.kind exactly", () => {
    expect(
      unionMembers(EmbeddedIntakeFieldSchema.get("kind").expression),
    ).toEqual(canonical);
  });
});
