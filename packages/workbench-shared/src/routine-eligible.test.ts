import { describe, expect, it } from "bun:test";
import {
  ROUTINE_ELIGIBLE_KINDS,
  isRoutineEligibleKind,
} from "./routine-eligible";

describe("ROUTINE_ELIGIBLE_KINDS", () => {
  it("lists the product-eligible Routines workflow kinds", () => {
    expect([...ROUTINE_ELIGIBLE_KINDS]).toEqual([
      "heartbeat",
      "prospect-engine",
      "last30days-research",
      "granola-call",
      "firecrawl-url-watch",
      "exa-topic-watch",
    ]);
  });
});

describe("isRoutineEligibleKind", () => {
  it("returns true for each allowlisted kind", () => {
    for (const kind of ROUTINE_ELIGIBLE_KINDS) {
      expect(isRoutineEligibleKind(kind)).toBe(true);
    }
  });

  it("returns false for structurally attachable but product-ineligible kinds", () => {
    expect(isRoutineEligibleKind("deck")).toBe(false);
    expect(isRoutineEligibleKind("smoke-test")).toBe(false);
    expect(isRoutineEligibleKind("competitor-analysis")).toBe(false);
    expect(isRoutineEligibleKind("granola")).toBe(false);
  });

  it("returns false for unknown kinds", () => {
    expect(isRoutineEligibleKind("not-a-workflow")).toBe(false);
    expect(isRoutineEligibleKind("")).toBe(false);
  });
});
