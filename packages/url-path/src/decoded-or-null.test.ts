import { describe, expect, test } from "bun:test";

import { decodedOrNull } from "./decoded-or-null";

describe("decodedOrNull", () => {
  test("decodes a percent-escaped segment", () => {
    expect(decodedOrNull("triage%20bot")).toBe("triage bot");
  });

  test("passes through a segment with nothing to decode", () => {
    expect(decodedOrNull("triage-bot")).toBe("triage-bot");
  });

  test("returns null for a malformed escape instead of throwing", () => {
    expect(decodedOrNull("%E0%A4%A")).toBeNull();
    expect(decodedOrNull("%")).toBeNull();
    expect(decodedOrNull("%zz")).toBeNull();
  });
});
