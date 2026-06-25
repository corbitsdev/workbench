import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizeHNPost } from "./normalize";
import type { HNPost, HNSearchResponse } from "./types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHNPost(value: unknown): HNPost {
  if (!isRecord(value)) {
    throw new Error("HN hit is not an object");
  }
  return {
    objectID:
      typeof value.objectID === "string"
        ? value.objectID
        : String(value.objectID),
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : undefined,
    points: typeof value.points === "number" ? value.points : undefined,
    num_comments:
      typeof value.num_comments === "number" ? value.num_comments : undefined,
    created_at_i:
      typeof value.created_at_i === "number" ? value.created_at_i : 0,
  };
}

function parseHNSearchResponse(value: unknown): HNSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.hits)) {
    throw new Error("HN response is not a valid search response");
  }
  return { hits: value.hits.map(parseHNPost) };
}

async function searchHackerNews(
  config: HackerNewsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const query = typeof args.query === "string" ? args.query : "";
  if (query.length === 0) {
    throw new Error("query is required");
  }
  const days =
    typeof args.days === "number" && args.days > 0
      ? Math.floor(args.days)
      : DEFAULT_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const limit =
    Number.isInteger(args.limit) && (args.limit as number) > 0
      ? Math.min(args.limit as number, MAX_HITS)
      : DEFAULT_HITS;

  const url = new URL(`${HN_BASE_URL}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("tags", "story");
  url.searchParams.set("numericFilters", `created_at_i>=${cutoff}`);
  url.searchParams.set("hitsPerPage", String(limit));

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`HN API error: ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  const parsed = parseHNSearchResponse(raw);
  const items = parsed.hits.map(normalizeHNPost);

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
