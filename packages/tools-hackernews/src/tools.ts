import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizeHNPost } from "./normalize";
import { HNSearchResponse } from "./types";

const HN_BASE_URL = "https://hn.algolia.com/api/v1";
const DEFAULT_DAYS = 30;
const DEFAULT_HITS = 10;
const MAX_HITS = 50;

export type HNFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type HackerNewsToolsConfig = {
  fetcher?: HNFetch;
};

export const HACKERNEWS_SEARCH_DEFINITION: ToolDefinition = {
  name: "hackernews_search",
  description:
    'Search Hacker News stories from the last N days. Scope each call with a specific query and the days window rather than pulling everything; the default returns 10 stories. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "hn", engagement: { upvotes, comments } }` (points map to upvotes).',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      days: {
        type: "number",
        description: "Number of days to look back (default 30).",
      },
      limit: {
        type: "number",
        description: "Maximum number of stories to return (1-50, default 10).",
      },
    },
    required: ["query"],
  },
};

const SearchArgs = type({
  query: "string > 0",
  "days?": "number",
  "limit?": "number.integer",
});

async function searchHackerNews(
  config: HackerNewsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`hackernews_search: ${parsed.summary}`);
  }

  const days =
    parsed.days !== undefined && parsed.days > 0
      ? Math.floor(parsed.days)
      : DEFAULT_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const limit =
    parsed.limit !== undefined && parsed.limit > 0
      ? Math.min(parsed.limit, MAX_HITS)
      : DEFAULT_HITS;

  const url = new URL(`${HN_BASE_URL}/search`);
  url.searchParams.set("query", parsed.query);
  url.searchParams.set("tags", "story");
  url.searchParams.set("numericFilters", `created_at_i>=${cutoff}`);
  url.searchParams.set("hitsPerPage", String(limit));

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`HN API error: ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  const searchResponse = HNSearchResponse(raw);
  if (searchResponse instanceof type.errors) {
    throw new Error(`HN response parse error: ${searchResponse.summary}`);
  }

  const items = searchResponse.hits.map(normalizeHNPost);
  return JSON.stringify(items, null, 2);
}

export function createHackerNewsTools(
  config: HackerNewsToolsConfig = {},
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: HACKERNEWS_SEARCH_DEFINITION,
      handler: (args, signal) => searchHackerNews(config, args, signal),
    },
  ];
}

export const HACKERNEWS_HUB_TOOLS = {
  hackernews_search: {
    definition: HACKERNEWS_SEARCH_DEFINITION,
    createTools: () => createHackerNewsTools(),
  },
};
