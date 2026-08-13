import { describe, expect, test } from "bun:test";

import {
  contextWindowControlState,
  contextWindowPatchValue,
} from "./context-window";

describe("contextWindowControlState", () => {
  test("an inheriting channel renders the bench-default mode with the resolved value", () => {
    expect(contextWindowControlState({ value: 20, source: "inherit" })).toEqual(
      { mode: "inherit", displayValue: 20 },
    );
  });

  test("an overriding channel renders the override mode with its own value", () => {
    expect(contextWindowControlState({ value: 5, source: "override" })).toEqual(
      { mode: "override", displayValue: 5 },
    );
  });
});

describe("contextWindowPatchValue", () => {
  test("switching to inherit always clears the override to null", () => {
    expect(contextWindowPatchValue("inherit", 5)).toBeNull();
  });

  test("override mode sends the field's own value", () => {
    expect(contextWindowPatchValue("override", 7)).toBe(7);
  });
});
