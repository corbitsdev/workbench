import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { ResearchItem } from "@workbench/last30days-core";
import { normalizePolymarketMarket } from "./normalize";
import type { PolymarketMarket } from "./types";

const fixture: PolymarketMarket = {
  id: "market-abc",
  question: "Will AI surpass human performance in all tasks by 2030?",
  outcomePrices: ["0.35", "0.65"],
  volume24hr: 125000.75,
  endDate: "2030-01-01T00:00:00Z",
  conditionId: "cond-xyz-123",
};

describe("normalizePolymarketMarket", () => {
  test("maps all fields correctly", () => {
    const item = normalizePolymarketMarket(fixture);
    expect(item.url).toBe("https://polymarket.com/event/cond-xyz-123");
    expect(item.title).toBe(
      "Will AI surpass human performance in all tasks by 2030?",
    );
    expect(item.publishedAt).toBe("2030-01-01T00:00:00Z");
    expect(item.source).toBe("polymarket");
    expect(item.engagement.upvotes).toBe(125001);
    expect(item.engagement.comments).toBe(0);
    expect(item.entityTag).toBe("cond-xyz-123");
  });

  test("falls back to current time when endDate is undefined", () => {
    const noEndDate: PolymarketMarket = { ...fixture, endDate: undefined };
    const before = Date.now();
    const item = normalizePolymarketMarket(noEndDate);
    const after = Date.now();
    const publishedMs = new Date(item.publishedAt).getTime();
    expect(publishedMs).toBeGreaterThanOrEqual(before);
    expect(publishedMs).toBeLessThanOrEqual(after);
  });

  test("rounds volume24hr to nearest integer", () => {
    const item = normalizePolymarketMarket({ ...fixture, volume24hr: 999.4 });
    expect(item.engagement.upvotes).toBe(999);
  });

  test("uses 0 for missing volume24hr", () => {
    const noVolume: PolymarketMarket = { ...fixture, volume24hr: undefined };
    const item = normalizePolymarketMarket(noVolume);
    expect(item.engagement.upvotes).toBe(0);
  });

  test("produces a valid ResearchItem", () => {
    const item = normalizePolymarketMarket(fixture);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });
});
