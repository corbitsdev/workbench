import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  AbDecisionPayloadSchema,
  AbPresetConfigPayloadSchema,
} from "./ab-compare";

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

describe("AbPresetConfigPayloadSchema", () => {
  test("accepts a shared prompt", () => {
    expect(
      rejects(AbPresetConfigPayloadSchema, {
        input: "Write a tagline for a GTM workbench.",
      }),
    ).toBe(false);
  });

  test("rejects an empty prompt", () => {
    expect(rejects(AbPresetConfigPayloadSchema, { input: "" })).toBe(true);
  });

  test("rejects a payload with no prompt (the presets collect only the prompt)", () => {
    expect(rejects(AbPresetConfigPayloadSchema, { instruction: "" })).toBe(
      true,
    );
  });
});
