import { describe, expect, test } from "bun:test";
import { toReactUiReasoning } from "./agent-part-adapter";

describe("toReactUiReasoning", () => {
  test("carries the text through", () => {
    expect(toReactUiReasoning({ kind: "reasoning", text: "thinking" })).toEqual(
      {
        kind: "reasoning",
        text: "thinking",
      },
    );
  });

  // chat's ReasoningPart has no duration field; react-ui's is optional, so
  // it stays absent rather than being fabricated as 0.
  test("omits durationMs entirely rather than inventing a zero", () => {
    expect(
      "durationMs" in toReactUiReasoning({ kind: "reasoning", text: "x" }),
    ).toBe(false);
  });
});
