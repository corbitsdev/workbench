import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  GammaIntakePayloadSchema,
  GammaPreviewPayloadSchema,
} from "./gamma-presentation";

const rejects = (schema: (v: unknown) => unknown, value: unknown): boolean =>
  schema(value) instanceof type.errors;

describe("GammaIntakePayloadSchema", () => {
  test("accepts an intake with a title, template, and a source", () => {
    expect(
      rejects(GammaIntakePayloadSchema, {
        deckTitle: "Security review deck",
        gammaId: "tmpl_1",
        audience: "Buyers",
        tone: "Confident",
        goal: "Book a pilot",
        text: "The brief.",
      }),
    ).toBe(false);
  });

  test("accepts an intake with no source (fetch steps are nonFatal)", () => {
    expect(
      rejects(GammaIntakePayloadSchema, {
        deckTitle: "A deck",
        gammaId: "tmpl_1",
      }),
    ).toBe(false);
  });

  test("rejects an intake missing the deck title", () => {
    expect(
      rejects(GammaIntakePayloadSchema, { deckTitle: "", gammaId: "tmpl_1" }),
    ).toBe(true);
  });

  test("rejects an intake missing the Gamma template", () => {
    expect(
      rejects(GammaIntakePayloadSchema, { deckTitle: "A deck", gammaId: "" }),
    ).toBe(true);
  });
});

describe("GammaPreviewPayloadSchema", () => {
  test("accepts an approve with no feedback", () => {
    expect(rejects(GammaPreviewPayloadSchema, { approved: true })).toBe(false);
  });

  test("accepts a refine with feedback", () => {
    expect(
      rejects(GammaPreviewPayloadSchema, {
        approved: false,
        feedback: "Tighten the opener.",
      }),
    ).toBe(false);
  });

  test("rejects a refine with no feedback (guidance-less re-roll)", () => {
    expect(rejects(GammaPreviewPayloadSchema, { approved: false })).toBe(true);
  });
});
