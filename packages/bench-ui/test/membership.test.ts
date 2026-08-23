import { describe, expect, test } from "bun:test";

import { isRawIdentifier } from "../src/membership";

describe("isRawIdentifier", () => {
  test("recognizes every platform id prefix this surface must never render", () => {
    expect(isRawIdentifier("ins_71f5c0c9c30026859014ccd9df8b1")).toBe(true);
    expect(isRawIdentifier("tnt_abc123")).toBe(true);
    expect(isRawIdentifier("prn_abc123")).toBe(true);
    expect(isRawIdentifier("role_abc123")).toBe(true);
    expect(isRawIdentifier("grant_abc123")).toBe(true);
  });

  test("leaves a human-assigned name alone", () => {
    expect(isRawIdentifier("Launch Team")).toBe(false);
    expect(isRawIdentifier("Myra")).toBe(false);
  });
});
