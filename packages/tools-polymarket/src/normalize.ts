import type { PolymarketMarket } from "./types";

export function normalizePolymarketMarket(item: PolymarketMarket) {
  return {
    url: `https://polymarket.com/event/${item.conditionId}`,
    title: item.question,
    publishedAt: item.endDate ?? new Date().toISOString(),
    source: "polymarket",
    engagement: {
      upvotes: Math.round(item.volume24hr ?? 0),
      comments: 0,
    },
    entityTag: item.conditionId,
  };
}
