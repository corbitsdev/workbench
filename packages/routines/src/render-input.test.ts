import { describe, expect, test } from "bun:test";

import { renderRoutineInput } from "./render-input";

describe("renderRoutineInput", () => {
  test("empty input renders to an empty string", () => {
    expect(renderRoutineInput({})).toBe("");
  });

  test("renders each field as a labeled line, in insertion order", () => {
    expect(
      renderRoutineInput({
        topic: "AI coding agents",
        focus: "Competing launches",
      }),
    ).toBe("topic: AI coding agents\nfocus: Competing launches");
  });

  test("renders numbers and booleans as plain values", () => {
    expect(renderRoutineInput({ limit: 5, urgent: true })).toBe(
      "limit: 5\nurgent: true",
    );
  });

  test("renders null and undefined fields as empty values", () => {
    expect(renderRoutineInput({ note: null })).toBe("note: ");
  });

  test("renders nested objects and arrays as JSON", () => {
    expect(
      renderRoutineInput({ tags: ["a", "b"], meta: { source: "stepper" } }),
    ).toBe('tags: ["a","b"]\nmeta: {"source":"stepper"}');
  });
});
