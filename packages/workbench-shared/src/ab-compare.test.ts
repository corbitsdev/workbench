import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { AbConfigPayloadSchema, AbDecisionPayloadSchema } from "./ab-compare";

function rejects(schema: (v: unknown) => unknown, value: unknown): boolean {
  return schema(value) instanceof type.errors;
}

describe("AbDecisionPayloadSchema", () => {
  test("rejects a free-text-only payload (no ranking)", () => {
    expect(rejects(AbDecisionPayloadSchema, { instruction: "pick 1" })).toBe(
      true,
    );
  });

  test("rejects an empty ranking", () => {
    expect(rejects(AbDecisionPayloadSchema, { ranking: [] })).toBe(true);
  });

  test("accepts a ranked winner with an optional rationale", () => {
    expect(
      rejects(AbDecisionPayloadSchema, {
        ranking: [{ rank: 1, label: "Variant 1", rationale: "Clearer." }],
      }),
    ).toBe(false);
  });

  test("accepts a top-level rationale (dock choice+prompt-box path)", () => {
    expect(
      rejects(AbDecisionPayloadSchema, {
        ranking: [{ rank: 1, label: "Variant 1" }],
        rationale: "Punchier.",
      }),
    ).toBe(false);
  });
});

describe("AbConfigPayloadSchema", () => {
  test("rejects a payload with no variants", () => {
    expect(rejects(AbConfigPayloadSchema, { instruction: "" })).toBe(true);
  });

  test("rejects an empty variants array", () => {
    expect(rejects(AbConfigPayloadSchema, { variants: [], input: "x" })).toBe(
      true,
    );
  });

  test("rejects a variant missing its model", () => {
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [{ providerName: "openai", input: "x" }],
        input: "x",
      }),
    ).toBe(true);
  });

  test("accepts fully-specified variants plus the shared input", () => {
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [
          {
            providerName: "openai",
            model: "gpt-4o",
            input: "Write a tagline.",
          },
        ],
        input: "Write a tagline.",
      }),
    ).toBe(false);
  });
});
