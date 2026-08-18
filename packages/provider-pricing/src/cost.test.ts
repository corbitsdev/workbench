import { describe, expect, test } from "bun:test";

import { computeCost, totalTokens } from "./cost";

describe("computeCost", () => {
  test("sums known rates into a total", () => {
    const result = computeCost(
      {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 500_000,
        thinking: 0,
      },
      {
        inputPerMTok: 3,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        outputPerMTok: 15,
        thinkingPerMTok: 15,
      },
    );
    expect(result.totalUsd).toBe(3 + 7.5);
    expect(result.byClass.input).toBe(3);
    expect(result.byClass.output).toBe(7.5);
  });

  test("zero-token classes contribute 0 even without a rate", () => {
    const result = computeCost(
      { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
      {
        inputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
        outputPerMTok: null,
        thinkingPerMTok: null,
      },
    );
    expect(result.totalUsd).toBe(2);
    expect(result.byClass.cacheRead).toBe(0);
  });

  test("tokens with a missing rate make the total null", () => {
    const result = computeCost(
      { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, thinking: 0 },
      {
        inputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
        outputPerMTok: null,
        thinkingPerMTok: null,
      },
    );
    expect(result.totalUsd).toBeNull();
    expect(result.byClass.output).toBeNull();
  });
});

describe("totalTokens", () => {
  test("sums every class", () => {
    expect(
      totalTokens({
        input: 1,
        cacheRead: 2,
        cacheWrite: 3,
        output: 4,
        thinking: 5,
      }),
    ).toBe(15);
  });
});
