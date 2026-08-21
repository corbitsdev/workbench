import { describe, expect, test } from "bun:test";
import { createRng, pick } from "./prng";

describe("createRng", () => {
  test("is deterministic for a given seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test("differs across seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a()).not.toBe(b());
  });

  test("stays in [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("pick", () => {
  test("only returns items from the input", () => {
    const rng = createRng(3);
    const items = ["a", "b", "c"] as const;
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(pick(rng, items));
    }
  });

  test("throws on an empty list", () => {
    const rng = createRng(3);
    expect(() => pick(rng, [])).toThrow();
  });

  test("is deterministic per rng state", () => {
    const items = ["a", "b", "c", "d"] as const;
    const first = pick(createRng(9), items);
    const second = pick(createRng(9), items);
    expect(first).toBe(second);
  });
});
