import { describe, expect, it } from "bun:test";
import { isRoutineEligibleKind } from "./routine-eligible";

describe("isRoutineEligibleKind", () => {
  it("is eligible when every required trigger field is a declared intake field", () => {
    expect(
      isRoutineEligibleKind(["topic"], new Set(["topic", "focus"]), false),
    ).toBe(true);
  });

  it("is eligible when a registered enricher covers required trigger fields absent from intake", () => {
    expect(
      isRoutineEligibleKind(
        ["enabledSources", "createdAfter"],
        new Set(),
        true,
      ),
    ).toBe(true);
  });

  it("is eligible with no required trigger fields, enricher or not", () => {
    expect(isRoutineEligibleKind([], new Set(), false)).toBe(true);
  });

  it("is NOT eligible when a required trigger field is neither declared nor enriched (granola-call's noteId)", () => {
    expect(isRoutineEligibleKind(["noteId"], new Set(), false)).toBe(false);
  });

  it("is NOT eligible when only some required fields are covered", () => {
    expect(
      isRoutineEligibleKind(["topic", "noteId"], new Set(["topic"]), false),
    ).toBe(false);
  });
});
