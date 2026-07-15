import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  analyticsModelDisplayCount,
  sumAnalyticsModelTokens,
} from "./model-tokens";

describe("sumAnalyticsModelTokens", () => {
  test("sums all token classes", () => {
    expect(
      sumAnalyticsModelTokens({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        thinkingTokens: 5,
      }),
    ).toBe(15);
  });

  test("treats missing fields as zero", () => {
    expect(sumAnalyticsModelTokens({ outputTokens: 7 })).toBe(7);
    expect(sumAnalyticsModelTokens({})).toBe(0);
  });
});

describe("analyticsModelDisplayCount", () => {
  test("prefers turn count when present", () => {
    expect(analyticsModelDisplayCount({ turnCount: 4, inputTokens: 100 })).toBe(
      4,
    );
  });

  test("falls back to token total for token-only models", () => {
    expect(analyticsModelDisplayCount({ turnCount: 0, inputTokens: 100 })).toBe(
      100,
    );
  });
});

describe("browser safety", () => {
  test("model-tokens has no imports — it must stay bundle-safe for apps/web", () => {
    // apps/web imports this module directly; any bare-specifier import here
    // (drizzle, @intx/db, node:*) can drag server-only code into the browser
    // bundle (CL-3737 shipped postgres.js to the browser via the barrel and
    // crashed the app with "Buffer is not defined").
    const source = readFileSync(
      path.join(import.meta.dir, "model-tokens.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+["'][^."']/m);
  });
});
