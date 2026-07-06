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

  test("rejects when a variant is missing its model", () => {
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [
          { providerName: "openai", model: "gpt-4o", input: "x" },
          { providerName: "anthropic", input: "x" },
        ],
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
          {
            providerName: "anthropic",
            model: "claude-opus-4-8",
            input: "Write a tagline.",
          },
        ],
        input: "Write a tagline.",
      }),
    ).toBe(false);
  });

  test("rejects a degenerate 1-variant comparison and an oversized 7-variant one (CL-2684)", () => {
    const variant = { providerName: "openai", model: "gpt-4o" };
    expect(
      rejects(AbConfigPayloadSchema, { variants: [variant], input: "x" }),
    ).toBe(true);
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: Array.from({ length: 7 }, () => variant),
        input: "x",
      }),
    ).toBe(true);
  });

  test("accepts variants with no per-variant input (the dock form shape, CL-2684)", () => {
    // The shared top-level input is authoritative; the per-variant copy is
    // optional, so the block-driven form can omit it.
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [
          { providerName: "openai-compatible", model: "kimi-k2.6" },
          { providerName: "anthropic", model: "claude-opus-4-8" },
        ],
        input: "Write a tagline.",
      }),
    ).toBe(false);
  });

  test("rejects a variant with an empty provider or model, and an empty shared input (CL-2684)", () => {
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [
          { providerName: "", model: "gpt-4o" },
          { providerName: "anthropic", model: "claude-opus-4-8" },
        ],
        input: "x",
      }),
    ).toBe(true);
    expect(
      rejects(AbConfigPayloadSchema, {
        variants: [
          { providerName: "openai", model: "gpt-4o" },
          { providerName: "anthropic", model: "claude-opus-4-8" },
        ],
        input: "",
      }),
    ).toBe(true);
  });
});
