import { describe, expect, test } from "bun:test";
import { readGenerateReply } from "./generate-output";

describe("readGenerateReply", () => {
  test("returns trimmed draft text for the generate step", () => {
    expect(readGenerateReply({ generate: { reply: "  Slide one  " } })).toBe(
      "Slide one",
    );
  });

  test("returns undefined when the step output is missing or empty", () => {
    expect(readGenerateReply({})).toBeUndefined();
    expect(readGenerateReply({ generate: { reply: "   " } })).toBeUndefined();
    expect(readGenerateReply({ generate: { notReply: "x" } })).toBeUndefined();
  });
});
