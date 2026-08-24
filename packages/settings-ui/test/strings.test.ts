import { describe, expect, test } from "bun:test";

import { SETTINGS_STRINGS } from "../src/strings";

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function" || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

describe("SETTINGS_STRINGS", () => {
  test("person-facing values drop intern chrome", () => {
    const values = stringValues(SETTINGS_STRINGS);
    expect(values.length).toBeGreaterThan(0);
    for (const text of values) {
      expect(text).not.toMatch(/auth API/i);
      expect(text).not.toMatch(/\bhub\b/i);
      expect(text).not.toMatch(/\bInference\b/);
      expect(text).not.toMatch(/\boperators?\b/i);
      expect(text).not.toMatch(/\bdeployments?\b/i);
    }
  });
});
