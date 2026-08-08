// Pure helper coverage for the "conversation memory" control: friendly
// labels for every raw value shape, and parsing whatever someone types back
// into the clamped integer (or "not ready") the settings panel needs.

import { describe, expect, test } from "bun:test";

import {
  contextWindowLabel,
  parseContextWindowInput,
} from "../src/context-window";

describe("contextWindowLabel", () => {
  test("undefined reads as the server's default of 20", () => {
    expect(contextWindowLabel(undefined)).toBe("Default (last 20 messages)");
  });

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
  test("blank input means 'default', i.e. undefined", () => {
    expect(parseContextWindowInput("")).toBeUndefined();
    expect(parseContextWindowInput("   ")).toBeUndefined();
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
