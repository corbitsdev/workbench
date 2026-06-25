import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizeXResult } from "./normalize";
import { XSearchResult, XSearchResponse } from "./types";

const XAI_BASE_URL = "https://api.x.ai";
const XAI_MODEL = "grok-4-1-fast";
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 10;
const DEFAULT_DAYS = 30;

export type XFetch = (input: string, init: RequestInit) => Promise<Response>;

export type XToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: XFetch;
};

const XSearchArgs = type({
  query: "string > 0",
  "days?": "number",
  "fromDate?": "string",
  "toDate?": "string",
  "limit?": "number",
});

export const X_SEARCH_DEFINITION: ToolDefinition = {
  name: "x_search",
  description:
    'Search X/Twitter via xAI Grok live search. Returns a semantic sampling of recent posts and content for the query. Results are a semantic sampling by Grok, not stable post IDs — cite as approximate. Scope the search with a specific query and the date range (days or fromDate/toDate) rather than pulling the maximum; returns up to 10 posts by default and at most 20 (raise via limit only when you genuinely need more). Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "x", author: "x-grok", provenance: "degraded", engagement: { upvotes: 0, comments: 0 } }`. Grok returns no engagement counts (always 0) and no stable per-post author, so author is always "x-grok" and every item is marked provenance "degraded" — treat as approximate.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      days: {
        type: "number",
        description:
          "Number of recent days to search when fromDate is not provided.",
      },
      fromDate: {
        type: "string",
        description: "Start date for X search, formatted as YYYY-MM-DD.",
      },
      toDate: {
        type: "string",
        description: "End date for X search, formatted as YYYY-MM-DD.",
      },
      limit: {
        type: "number",
        description: "Maximum number of posts to return (1-20, default 10).",
      },
    },
    required: ["query"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseXSearchResult(value: unknown): XSearchResult {
  if (!isRecord(value)) {
    throw new Error("xAI result item is not an object");
  }
  const engagement = isRecord(value.engagement) ? value.engagement : undefined;
  let engagementSignal: string | undefined;
  if (typeof value.engagementSignal === "string") {
    engagementSignal = value.engagementSignal;
  } else if (engagement !== undefined) {
    engagementSignal = JSON.stringify(engagement);
  }
  const authorHandle =
    typeof value.author_handle === "string" ? value.author_handle : "";
  const text = typeof value.text === "string" ? value.text : "";
  let title = text.slice(0, 80);
  if (typeof value.title === "string") {
    title = value.title;
  } else if (authorHandle.length > 0) {
    title = `@${authorHandle}`;
  }
  let summary = text;
  if (typeof value.summary === "string") {
    summary = value.summary;
  } else if (typeof value.why_relevant === "string") {
    summary = value.why_relevant;
  }
  let publishedAt: string | undefined;
  if (typeof value.publishedAt === "string") {
    publishedAt = value.publishedAt;
  } else if (typeof value.date === "string") {
    publishedAt = value.date;
  }

  const item = {
    title,
    url: typeof value.url === "string" ? value.url : undefined,
    summary,
    publishedAt,
    engagementSignal,
  };
  const validated = XSearchResult(item);
  if (validated instanceof type.errors) {
    throw new Error(`xAI result item failed validation: ${validated.summary}`);
  }
  return validated;
}

/**
 * Parses the xAI response text into an array of XSearchResult items. Each
 * item is validated through the XSearchResult arktype schema.
 *
 * XSearchResponse (the { results: XSearchResult[] } schema) is intentionally
 * not used here as a top-level validator: the xAI API returns either a bare
 * array or an { items: [...] } envelope — neither matches XSearchResponse's
 * shape. XSearchResponse is exported for downstream consumers (e.g. the hub
 * tool registry) that want a typed wrapper around a results array.
 */
function parseXSearchResponse(content: string): XSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*"items"[\s\S]*\}/);
    if (jsonMatch === null) {
      throw new Error("xAI response content is not valid JSON");
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error("xAI response content is not valid JSON");
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.map(parseXSearchResult);
  }
  if (isRecord(parsed) && Array.isArray(parsed.items)) {
    return parsed.items.map(parseXSearchResult);
  }
  throw new Error("xAI response content is not a JSON array or items object");
}

function resolveBaseUrl(config: XToolsConfig): string {
  const trimmed = config.baseURL?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return XAI_BASE_URL;
  }
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    return XAI_BASE_URL;
  }
}

function resolveResponsesEndpoint(config: XToolsConfig): string {
  const baseUrl = resolveBaseUrl(config);
  if (baseUrl.endsWith("/v1")) {
    return `${baseUrl}/responses`;
  }
  return `${baseUrl}/v1/responses`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type ParsedXSearchArgs = typeof XSearchArgs.infer;

function resolveDays(args: ParsedXSearchArgs): number {
  if (args.days === undefined || !Number.isFinite(args.days)) {
    return DEFAULT_DAYS;
  }
  return Math.max(1, Math.floor(args.days));
}

function resolveDateRange(args: ParsedXSearchArgs): {
  fromDate: string;
  toDate: string;
} {
  const toDate =
    args.toDate !== undefined && args.toDate.length > 0
      ? args.toDate
      : undefined;
  const fromDate =
    args.fromDate !== undefined && args.fromDate.length > 0
      ? args.fromDate
      : undefined;
  if (fromDate !== undefined && toDate !== undefined) {
    return { fromDate, toDate };
  }

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - resolveDays(args));

  return {
    fromDate: fromDate ?? formatDate(start),
    toDate: toDate ?? formatDate(end),
  };
}

function extractOutputText(data: unknown): string {
  if (!isRecord(data)) {
    throw new Error("xAI response is not an object");
  }

  const output = data.output;
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        continue;
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (
            isRecord(contentItem) &&
            contentItem.type === "output_text" &&
            typeof contentItem.text === "string"
          ) {
            return contentItem.text;
          }
        }
      }
      if (typeof item.text === "string") {
        return item.text;
      }
    }
  }

  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const firstChoice: unknown = data.choices[0];
    if (isRecord(firstChoice) && isRecord(firstChoice.message)) {
      const content = firstChoice.message.content;
      if (typeof content === "string") {
        return content;
      }
    }
  }

  throw new Error("xAI API returned empty response");
}

async function searchX(
  config: XToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = XSearchArgs(rawArgs);
  if (parsed instanceof type.errors) {
    throw new Error(`x_search: ${parsed.summary}`);
  }
  const args = parsed;

  const query = args.query;

  const endpoint = resolveResponsesEndpoint(config);
  const { fromDate, toDate } = resolveDateRange(args);
  const limit =
    typeof args.limit === "number" &&
    Number.isInteger(args.limit) &&
    args.limit > 0
      ? Math.min(args.limit, MAX_RESULTS)
      : DEFAULT_RESULTS;

  const body = {
    model: XAI_MODEL,
    tools: [{ type: "x_search", from_date: fromDate, to_date: toDate }],
    input: [
      {
        role: "user",
        content: `Search for posts about: ${query}
Focus on posts from ${fromDate} to ${toDate}. Find up to ${limit} high-quality, relevant posts.

Return only valid JSON in this exact format, no prose:
{
  "items": [
    {
      "text": "Post text content",
      "url": "https://x.com/user/status/...",
      "author_handle": "username",
      "date": "YYYY-MM-DD or null if unknown",
      "engagement": { "likes": 100, "reposts": 25, "replies": 15, "quotes": 5 },
      "why_relevant": "Brief explanation of relevance",
      "relevance": 0.85
    }
  ]
}`,
      },
    ],
  };

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const detail = errorBody.length > 0 ? `: ${errorBody.slice(0, 500)}` : "";
    throw new Error(
      `xAI API error: ${response.status} ${response.statusText}${detail}`,
    );
  }

  const data: unknown = await response.json();
  const results = parseXSearchResponse(extractOutputText(data));
  const normalized = results.map((item) => normalizeXResult(item, query));
  return JSON.stringify(normalized, null, 2);
}

export function createXTools(config: XToolsConfig): AgentTool[] {
  return [
    {
      kind: "string",
      definition: X_SEARCH_DEFINITION,
      handler: (args, signal) => searchX(config, args, signal),
    },
  ];
}

export const X_HUB_TOOLS = {
  x_search: {
    definition: X_SEARCH_DEFINITION,
    providerName: "xai" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createXTools({ apiKey: config.apiKey, baseURL: config.baseURL }),
  },
};
