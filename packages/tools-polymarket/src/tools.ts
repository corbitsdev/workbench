import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizePolymarketMarket } from "./normalize";
import { PolymarketMarket } from "./types";

const POLYMARKET_API_BASE = "https://gamma-api.polymarket.com";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Not JSON-expressible (function field) — kept as plain type.
export type PolymarketFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

// Contains a function field (fetcher) — not serializable, kept as plain type.
export type PolymarketToolsConfig = {
  fetcher?: PolymarketFetch;
};

export const POLYMARKET_ODDS_DEFINITION: ToolDefinition = {
  name: "polymarket_odds",
  description:
    'Search active Polymarket prediction markets matching a query. Use a specific query to scope results to the markets you actually need rather than pulling everything; returns the top 10 by default. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "polymarket", entityTag (market condition id), engagement: { upvotes, comments: 0 } }`, where engagement.upvotes carries 24-hour market volume and comments is always 0. Note: publishedAt is the market end date (often in the future), not a publish date.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      limit: {
        type: "number",
        description: "Maximum number of markets to return (1-50, default 10).",
      },
    },
    required: ["query"],
  },
};

const SearchArgs = type({
  query: "string > 0",
  "limit?": "number.integer > 0",
});

async function searchPolymarket(
  config: PolymarketToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`polymarket_odds: ${parsed.summary}`);
  }

  const limit =
    parsed.limit !== undefined
      ? Math.min(parsed.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const url = new URL(`${POLYMARKET_API_BASE}/markets`);
  url.searchParams.set("q", parsed.query);
  url.searchParams.set("active", "true");
  url.searchParams.set("limit", String(limit));

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(
      `Polymarket API error: ${response.status} ${response.statusText}`,
    );
  }

  const raw: unknown = await response.json();
  // Strict-reject: items that don't match the schema are dropped rather than coerced.
  // The old parsePolymarketMarket coerced numeric id→String, missing question→"", and
  // missing outcomePrices→[]. Dropping is intentional — surfacing coerced garbage to
  // callers is worse than a shorter result set.
  const markets = Array.isArray(raw)
    ? raw.flatMap((item) => {
        const p = PolymarketMarket(item);
        return p instanceof type.errors ? [] : [p];
      })
    : [];
  const items = markets.map(normalizePolymarketMarket);

  return JSON.stringify(items, null, 2);
}

export function createPolymarketTools(
  config: PolymarketToolsConfig = {},
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: POLYMARKET_ODDS_DEFINITION,
      handler: (args, signal) => searchPolymarket(config, args, signal),
    },
  ];
}

export const POLYMARKET_HUB_TOOLS = {
  polymarket_odds: {
    sideEffect: "read" as const,
    definition: POLYMARKET_ODDS_DEFINITION,
    createTools: () => createPolymarketTools(),
  },
};
