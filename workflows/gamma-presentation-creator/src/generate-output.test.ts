import { describe, expect, test } from "bun:test";
import { readGenerateReply } from "./generate-output";

describe("readGenerateReply", () => {
  test("returns trimmed draft text for a generate round", () => {
    expect(
      readGenerateReply({ "generate-1": { reply: "  Slide one  " } }, 1),
    ).toBe("Slide one");
  });

  test("returns undefined when the round is missing or empty", () => {
    expect(readGenerateReply({}, 1)).toBeUndefined();
    expect(
      readGenerateReply({ "generate-1": { reply: "   " } }, 1),
    ).toBeUndefined();
    expect(
      readGenerateReply({ "generate-1": { notReply: "x" } }, 1),
    ).toBeUndefined();
  });
});
