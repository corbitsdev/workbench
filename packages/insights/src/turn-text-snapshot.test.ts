import { describe, expect, test } from "bun:test";

import { snapshotTextFromParts } from "./turn-text-snapshot";

describe("snapshotTextFromParts", () => {
  test("concatenates text parts within a turn by ordinal", () => {
    const text = snapshotTextFromParts(
      ["turn_1"],
      [
        { turnId: "turn_1", type: "text", content: "world", ordinal: 1 },
        { turnId: "turn_1", type: "text", content: "hello ", ordinal: 0 },
      ],
    );
    expect(text).toBe("hello world");
  });

  test("concatenates across turns oldest first, ignoring turns not passed", () => {
    const text = snapshotTextFromParts(
      ["turn_1", "turn_2"],
      [
        { turnId: "turn_2", type: "text", content: "second", ordinal: 0 },
        { turnId: "turn_1", type: "text", content: "first", ordinal: 0 },
        { turnId: "turn_3", type: "text", content: "unreferenced", ordinal: 0 },
      ],
    );
    expect(text).toBe("firstsecond");
  });

  test("skips non-text parts and null content", () => {
    const text = snapshotTextFromParts(
      ["turn_1"],
      [
        { turnId: "turn_1", type: "tool", content: "ignored", ordinal: 0 },
        { turnId: "turn_1", type: "text", content: null, ordinal: 1 },
        { turnId: "turn_1", type: "text", content: "kept", ordinal: 2 },
      ],
    );
    expect(text).toBe("kept");
  });

  test("a turn with no text parts contributes nothing, not a gap", () => {
    const text = snapshotTextFromParts(["turn_1"], []);
    expect(text).toBe("");
  });
});
