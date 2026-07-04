import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { normalizeRedditPost } from "./normalize";
import type { RedditPost, RedditTopComment } from "./types";

// Reddit is fetched through ScrapeCreators rather than Reddit's own API: the
// public JSON endpoints get IP-blocked from datacenter hosts and the authenticated
// API needs an OAuth flow we don't run server-side. Endpoints verified against
// https://docs.scrapecreators.com and the reference last30days skill
// (mvanhorn/last30days-skill). Update if the API changes.
export const SCRAPECREATORS_DEFAULT_BASE_URL = "https://api.scrapecreators.com";

const MAX_ERROR_BODY_LENGTH = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export type RedditFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type RedditToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: RedditFetch;
};

const RedditSortLiteral = type('"relevance" | "new" | "top" | "comment_count"');
const RedditTimeframeLiteral = type(
  '"all" | "day" | "week" | "month" | "year"',
);

const RedditSearchArgs = type({
  query: "string > 0",
  "sort?": RedditSortLiteral,
  "timeframe?": RedditTimeframeLiteral,
  "limit?": "1 <= number.integer <= 100",
});

const SUBREDDIT_SORTS = new Set(["relevance", "hot", "top", "new", "comments"]);
const TIMEFRAMES = new Set(["all", "day", "week", "month", "year"]);

export interface NormalizedSubredditSearch {
  subreddit: string;
  query: string;
  sort: string;
  timeframe: string;
  limit: number;
}

/**
 * Relocated per-row normalization for a subreddit search (CL-2769).
 *
 * The reddit-opportunity-scanner review gate maps each planned search straight
 * into `reddit_subreddit_search`; the run-page panel used to strip a leading
 * "r/" from the subreddit and default sort/timeframe/limit client-side before
 * submitting. Moving that here (mirroring CL-2765's normalizeIntake) makes every
 * search row COMPLETE regardless of the path it took: a block-form submission
 * carrying "r/devops" and no sort/timeframe/limit reaches the API with a bare
 * "devops" subreddit and the panel's former defaults, so a naive verbatim
 * migration can't hand the tool an "r/"-prefixed subreddit the API rejects.
 */

// The workflow's search-plan default limit — kept in lockstep with the panel's
// per-row default (workflows/reddit-opportunity-scanner/src/ui.tsx). The review
// gate always sends a concrete `limit`, so this fallback only applies to a
// direct tool call that omits it (e.g. Larry driving the tool ad hoc).
const SUBREDDIT_DEFAULT_LIMIT = 15;

export function normalizeSubredditSearchArgs(
  raw: Record<string, unknown>,
): NormalizedSubredditSearch {
  const subredditRaw =
    typeof raw.subreddit === "string" ? raw.subreddit.trim() : "";
  const subreddit = subredditRaw.replace(/^\/?r\//iu, "").trim();
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  const sort =
    typeof raw.sort === "string" && SUBREDDIT_SORTS.has(raw.sort)
      ? raw.sort
      : "relevance";
  const timeframe =
    typeof raw.timeframe === "string" && TIMEFRAMES.has(raw.timeframe)
      ? raw.timeframe
      : "month";
  const limit =
    typeof raw.limit === "number" && raw.limit > 0
      ? Math.min(Math.floor(raw.limit), MAX_LIMIT)
      : SUBREDDIT_DEFAULT_LIMIT;
  return { subreddit, query, sort, timeframe, limit };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolvedBaseURL(config: RedditToolsConfig): string {
  const url = config.baseURL?.trim();
  if (url && url.length > 0) {
    return url.replace(/\/$/, "");
  }
  return SCRAPECREATORS_DEFAULT_BASE_URL;
}

async function fetchJSON(
  config: RedditToolsConfig,
  url: URL,
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: { "x-api-key": config.apiKey },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail =
      body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : "";
    throw new Error(
      `ScrapeCreators API error: ${response.status} ${response.statusText}${detail}`,
    );
  }
  return response.json();
}

function stringField(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function numberField(rec: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  return 0;
}

// ScrapeCreators returns posts under `posts` on both reddit endpoints, but tolerate
// a bare array or alternate envelopes.
function extractPosts(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (!isRecord(data)) {
    throw new Error("ScrapeCreators reddit response is not an object");
  }
  for (const key of ["posts", "data", "results"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

// /v1/reddit/search returns epoch seconds (created_utc/created); the subreddit
// search endpoint returns an ISO string (created_at). Resolve both to epoch seconds.
function resolveCreatedUtc(rec: Record<string, unknown>): number {
  const epoch = numberField(rec, ["created_utc", "created"]);
  if (epoch > 0) {
    return epoch;
  }
  const iso = rec["created_at"];
  if (typeof iso === "string" && iso.length > 0) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return 0;
}

function resolveSubreddit(rec: Record<string, unknown>): string {
  const direct = rec["subreddit"];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  if (isRecord(direct)) {
    return stringField(direct, ["name", "display_name", "subreddit"]);
  }
  return stringField(rec, ["subreddit_name_prefixed"]).replace(/^r\//, "");
}

// ScrapeCreators sometimes attaches the thread's top comment(s) on the post
// (key varies: `top_comment`, `top_comments`, `comments`). When present they are
// the strongest community signal, so pass them through; when absent the post is
// still emitted without them.
function extractTopComments(rec: Record<string, unknown>): RedditTopComment[] {
  const raw = rec["top_comments"] ?? rec["comments"] ?? rec["top_comment"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const comments: RedditTopComment[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const text = stringField(entry, ["body", "text", "comment"]);
    if (text.length === 0) continue;
    const author = stringField(entry, ["author", "username"]);
    const comment: RedditTopComment = {
      text,
      score: Math.floor(numberField(entry, ["ups", "score", "votes"])),
    };
    if (author.length > 0) comment.author = author;
    comments.push(comment);
  }
  return comments;
}

// Returns null for any item we cannot turn into a usable research result. A post
// without a thread permalink or a resolvable date is dropped rather than emitted as
// a bare `reddit.com` URL or a 1970-01-01 date, either of which would corrupt the
// downstream recency ranking instead of failing visibly.
function parseRedditPost(value: unknown): RedditPost | null {
  if (!isRecord(value)) {
    return null;
  }
  const permalink = stringField(value, ["permalink"]);
  const created_utc = resolveCreatedUtc(value);
  if (permalink.length === 0 || created_utc === 0) {
    return null;
  }
  const topComments = extractTopComments(value);
  const post: RedditPost = {
    id: stringField(value, ["id", "name"]),
    title: stringField(value, ["title"]),
    url: stringField(value, ["url"]),
    permalink,
    created_utc,
    ups: Math.floor(numberField(value, ["ups", "score", "votes"])),
    num_comments: Math.floor(
      numberField(value, ["num_comments", "comment_count"]),
    ),
    subreddit: resolveSubreddit(value),
  };
  if (topComments.length > 0) {
    post.topComments = topComments;
  }
  return post;
}

type CommonParams = {
  sort?: string;
  timeframe?: string;
  limit?: number;
};

function resolveLimit(args: CommonParams): number {
  if (typeof args.limit === "number" && args.limit > 0) {
    return Math.min(Math.floor(args.limit), MAX_LIMIT);
  }
  return DEFAULT_LIMIT;
}

function applyCommonParams(url: URL, args: CommonParams): void {
  const sort =
    typeof args.sort === "string" && args.sort.length > 0
      ? args.sort
      : "relevance";
  url.searchParams.set("sort", sort);
  const timeframe =
    typeof args.timeframe === "string" && args.timeframe.length > 0
      ? args.timeframe
      : "month";
  url.searchParams.set("timeframe", timeframe);
}

const REDDIT_SEARCH_DEFINITION: ToolDefinition = {
  name: "reddit_search",
  description:
    'Search Reddit posts across all subreddits via ScrapeCreators. Scope the search with a focused query and timeframe rather than pulling everything; returns 10 results by default. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "reddit", author ("r/<subreddit>"), engagement: { upvotes, comments } }`, sometimes with a `topComments` array.',
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query string." },
      sort: {
        type: "string",
        description:
          "Sort order: relevance, new, top, or comment_count (default relevance).",
      },
      timeframe: {
        type: "string",
        description:
          "Time filter: all, day, week, month, or year (default month).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-100, default 10).",
      },
    },
    required: ["query"],
  },
};

const REDDIT_SUBREDDIT_SEARCH_DEFINITION: ToolDefinition = {
  name: "reddit_subreddit_search",
  description:
    'Search Reddit posts within a specific subreddit via ScrapeCreators. Scope the search with a focused query, subreddit, and timeframe rather than pulling everything; returns 10 results by default. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "reddit", author ("r/<subreddit>"), engagement: { upvotes, comments } }`, sometimes with a `topComments` array.',
  inputSchema: {
    type: "object",
    properties: {
      subreddit: {
        type: "string",
        description: "The subreddit name (without the r/ prefix).",
      },
      query: { type: "string", description: "The search query string." },
      sort: {
        type: "string",
        description:
          "Sort order: relevance, hot, top, new, or comments (default relevance).",
      },
      timeframe: {
        type: "string",
        description:
          "Time filter: all, day, week, month, or year (default month).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-100, default 10).",
      },
    },
    required: ["subreddit", "query"],
  },
};

async function searchReddit(
  config: RedditToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = RedditSearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`reddit_search: ${parsed.summary}`);
  }
  const url = new URL(`${resolvedBaseURL(config)}/v1/reddit/search`);
  url.searchParams.set("query", parsed.query);
  applyCommonParams(url, parsed);

  const data = await fetchJSON(config, url, signal);
  const posts = extractPosts(data)
    .map(parseRedditPost)
    .filter((post): post is RedditPost => post !== null)
    .slice(0, resolveLimit(parsed));
  return JSON.stringify(posts.map(normalizeRedditPost), null, 2);
}

async function searchSubreddit(
  config: RedditToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const norm = normalizeSubredditSearchArgs(args);
  if (norm.subreddit.length === 0 || norm.query.length === 0) {
    throw new Error(
      "reddit_subreddit_search: subreddit and query are required",
    );
  }
  const url = new URL(`${resolvedBaseURL(config)}/v1/reddit/subreddit/search`);
  url.searchParams.set("subreddit", norm.subreddit);
  url.searchParams.set("query", norm.query);
  url.searchParams.set("sort", norm.sort);
  url.searchParams.set("timeframe", norm.timeframe);

  const data = await fetchJSON(config, url, signal);
  const posts = extractPosts(data)
    .map(parseRedditPost)
    .filter((post): post is RedditPost => post !== null)
    .slice(0, norm.limit);
  return JSON.stringify(posts.map(normalizeRedditPost), null, 2);
}

export function createRedditTools(config: RedditToolsConfig): AgentTool[] {
  return [
    {
      kind: "string",
      definition: REDDIT_SEARCH_DEFINITION,
      handler: (args, signal) => searchReddit(config, args, signal),
    },
    {
      kind: "string",
      definition: REDDIT_SUBREDDIT_SEARCH_DEFINITION,
      handler: (args, signal) => searchSubreddit(config, args, signal),
    },
  ];
}

export const REDDIT_HUB_TOOLS = {
  reddit_search: {
    definition: REDDIT_SEARCH_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createRedditTools(config),
  },
  reddit_subreddit_search: {
    definition: REDDIT_SUBREDDIT_SEARCH_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createRedditTools(config),
  },
};
