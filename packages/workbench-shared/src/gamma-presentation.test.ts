import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { GammaIntakePayloadSchema } from "./gamma-presentation";

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

  test("accepts an intake carrying an optional templateSystemPrompt", () => {
    expect(
      rejects(GammaIntakePayloadSchema, {
        deckTitle: "A deck",
        gammaId: "tmpl_1",
        templateSystemPrompt: "Use a formal, security-audience tone.",
      }),
    ).toBe(false);
  });
});
