import { describe, expect, it } from "bun:test";
import {
  AUTOMATION_ELIGIBLE_KINDS,
  isAutomationEligibleKind,
} from "./automation-eligible";

describe("AUTOMATION_ELIGIBLE_KINDS", () => {
  it("lists the product-eligible Automations workflow kinds", () => {
    expect([...AUTOMATION_ELIGIBLE_KINDS]).toEqual([
      "heartbeat",
      "prospect-engine",
      "last30days-research",
    ]);
  });
});

describe("isAutomationEligibleKind", () => {
  it("returns true for each allowlisted kind", () => {
    for (const kind of AUTOMATION_ELIGIBLE_KINDS) {
      expect(isAutomationEligibleKind(kind)).toBe(true);
    }
  });

  it("returns false for structurally attachable but product-ineligible kinds", () => {
    expect(isAutomationEligibleKind("deck")).toBe(false);
    expect(isAutomationEligibleKind("smoke-test")).toBe(false);
    expect(isAutomationEligibleKind("competitor-analysis")).toBe(false);
    expect(isAutomationEligibleKind("granola")).toBe(false);
  });

  it("returns false for unknown kinds", () => {
    expect(isAutomationEligibleKind("not-a-workflow")).toBe(false);
    expect(isAutomationEligibleKind("")).toBe(false);
  });
});
