// Pure helper coverage for the bench-wide "default conversation memory"
// control: friendly labels for every raw value, and parsing whatever
// someone types back into the clamped integer (or "not ready") the
// bench-settings panel needs.

import { describe, expect, test } from "bun:test";

import {
  contextWindowLabel,
  parseContextWindowInput,
} from "../src/context-window";

describe("contextWindowLabel", () => {
  test("0 reads as disabled, not as a bare zero", () => {
    expect(contextWindowLabel(0)).toBe(
      "Disabled — mentioned agents see no history",
    );
  });

  test("any other integer reads as a friendly message count", () => {
    expect(contextWindowLabel(5)).toBe("Last 5 messages");
    expect(contextWindowLabel(200)).toBe("Last 200 messages");
  });
});

describe("parseContextWindowInput", () => {
  test("blank input is not ready to submit", () => {
    expect(parseContextWindowInput("")).toBeNull();
    expect(parseContextWindowInput("   ")).toBeNull();
  });

  test("parses a plain integer", () => {
    expect(parseContextWindowInput("5")).toBe(5);
  });

  test("clamps above the 200 ceiling", () => {
    expect(parseContextWindowInput("10000")).toBe(200);
  });

  test("clamps a negative value up to the 0 floor", () => {
    expect(parseContextWindowInput("-3")).toBe(0);
  });

  test("returns null, not a coerced number, for non-numeric input", () => {
    expect(parseContextWindowInput("lots")).toBeNull();
  });
});
