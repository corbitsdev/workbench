/// <reference types="bun" />
import type { KeyboardEvent } from "react";
import { describe, expect, it } from "bun:test";
import { clampListIndex, stepListIndexOnKeyDown } from "./moment-listbox";

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    preventDefault: () => {},
  } as KeyboardEvent;
}

describe("moment-listbox", () => {
  it("clamps selection to list bounds", () => {
    expect(clampListIndex(-1, 3)).toBe(0);
    expect(clampListIndex(9, 3)).toBe(2);
    expect(clampListIndex(1, 0)).toBe(0);
  });

  it("steps selection on arrow and home/end keys", () => {
    let prevented = false;
    const event = {
      key: "ArrowDown",
      preventDefault: () => {
        prevented = true;
      },
    } as KeyboardEvent;

    expect(stepListIndexOnKeyDown(event, 0, 3)).toBe(1);
    expect(prevented).toBe(true);

    expect(stepListIndexOnKeyDown(keyEvent("k"), 2, 3)).toBe(1);
    expect(stepListIndexOnKeyDown(keyEvent("Home"), 2, 3)).toBe(0);
    expect(stepListIndexOnKeyDown(keyEvent("End"), 0, 3)).toBe(2);
    expect(stepListIndexOnKeyDown(keyEvent("x"), 0, 3)).toBeNull();
  });
});
