import { describe, it, expect } from "bun:test";
import { parseSingleSelection } from "./prompts";

describe("parseSingleSelection", () => {
  it("returns the 0-based index for a valid choice", () => {
    expect(parseSingleSelection("2", 3)).toBe(1);
  });
  it("returns null for empty, null, or out-of-range input", () => {
    expect(parseSingleSelection("", 3)).toBeNull();
    expect(parseSingleSelection(null, 3)).toBeNull();
    expect(parseSingleSelection("0", 3)).toBeNull();
    expect(parseSingleSelection("4", 3)).toBeNull();
    expect(parseSingleSelection("x", 3)).toBeNull();
  });
});
