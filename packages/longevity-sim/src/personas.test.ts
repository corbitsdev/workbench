import { describe, expect, test } from "bun:test";
import { createRng } from "./prng";
import { SALES_TEAM, utterance } from "./personas";

describe("SALES_TEAM", () => {
  test("has exactly 10 distinct personas", () => {
    expect(SALES_TEAM).toHaveLength(10);
    const keys = new Set(SALES_TEAM.map((persona) => persona.key));
    expect(keys.size).toBe(10);
  });

  test("every persona has topics and a positive cadence weight", () => {
    for (const persona of SALES_TEAM) {
      expect(persona.topics.length).toBeGreaterThan(0);
      expect(persona.cadenceWeight).toBeGreaterThan(0);
    }
  });

  test("no persona name or topic contains a known real company/person name", () => {
    const banned = ["salesforce", "google", "microsoft", "acme corp"];
    for (const persona of SALES_TEAM) {
      const haystack = [persona.name, ...persona.topics]
        .join(" ")
        .toLowerCase();
      for (const term of banned) {
        expect(haystack).not.toContain(term);
      }
    }
  });
});

describe("utterance", () => {
  test("is deterministic for the same persona, rng seed, and simDay", () => {
    const persona = SALES_TEAM[0];
    if (persona === undefined) throw new Error("expected a persona");
    const a = utterance(persona, createRng(11), 3);
    const b = utterance(persona, createRng(11), 3);
    expect(a).toBe(b);
  });

  test("varies across draws for the same persona", () => {
    const persona = SALES_TEAM[0];
    if (persona === undefined) throw new Error("expected a persona");
    const rng = createRng(5);
    const draws = new Set(
      Array.from({ length: 20 }, () => utterance(persona, rng, 1)),
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  test("every persona produces chatter mentioning one of its own topics", () => {
    const rng = createRng(17);
    for (const persona of SALES_TEAM) {
      const text = utterance(persona, rng, 2);
      expect(text.length).toBeGreaterThan(0);
      expect(persona.topics.some((topic) => text.includes(topic))).toBe(true);
    }
  });
});
