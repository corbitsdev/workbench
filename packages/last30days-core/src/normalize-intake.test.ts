import { describe, expect, test } from "bun:test";
import { normalizeIntake } from "./normalize-intake";

describe("normalizeIntake (CL-2765)", () => {
  test("derives query = focus and days = 30 from a block-form { topic, focus } payload", () => {
    const result = normalizeIntake({
      topic: "AI coding agents",
      focus: "enterprise procurement risks",
    });
    expect(result).toEqual({
      topic: "AI coding agents",
      query: "enterprise procurement risks",
      days: 30,
    });
  });

  test("falls the query back to the topic when no focus is given", () => {
    expect(normalizeIntake({ topic: "AI coding agents" })).toEqual({
      topic: "AI coding agents",
      query: "AI coding agents",
      days: 30,
    });
  });

  test("a blank focus does not blank the query — it falls back to the topic", () => {
    expect(normalizeIntake({ topic: "Neobanks", focus: "   " }).query).toBe(
      "Neobanks",
    );
  });

  test("preserves the legacy panel's already-derived { topic, query, days }", () => {
    const result = normalizeIntake({
      topic: "Neobanks",
      query: "neobank launches Q2",
      days: 14,
    });
    expect(result).toEqual({
      topic: "Neobanks",
      query: "neobank launches Q2",
      days: 14,
    });
  });

  test("prefers an explicit query over focus (legacy shape wins)", () => {
    expect(
      normalizeIntake({ topic: "T", query: "explicit", focus: "focus" }).query,
    ).toBe("explicit");
  });

  test("trims whitespace off the topic and query", () => {
    expect(normalizeIntake({ topic: "  T  ", focus: "  F  " })).toEqual({
      topic: "T",
      query: "F",
      days: 30,
    });
  });

  test("defaults days to 30 when it is not a finite number", () => {
    expect(normalizeIntake({ topic: "T", days: Number.NaN }).days).toBe(30);
    expect(normalizeIntake({ topic: "T", days: "30" }).days).toBe(30);
  });

  test("throws on a topic-less payload", () => {
    expect(() => normalizeIntake({ focus: "just a focus" })).toThrow(
      /must include topic/,
    );
    expect(() => normalizeIntake({ topic: "   " })).toThrow(
      /must include topic/,
    );
  });
});
