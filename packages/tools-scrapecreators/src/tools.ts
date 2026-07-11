import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  normalizeTikTokPost,
  normalizeInstagramPost,
  normalizeThreadsPost,
  normalizePinterestPin,
} from "./normalize";
import type {
  TikTokPost,
  InstagramPost,
  ThreadsPost,
  PinterestPin,
} from "./types";

const SearchArgs = type({ query: "string > 0", "limit?": "number" });

// Endpoints verified against https://docs.scrapecreators.com/llms.txt and the reference
// last30days skill (mvanhorn/last30days-skill). Update if the API changes.
export const SCRAPECREATORS_DEFAULT_BASE_URL = "https://api.scrapecreators.com";

const MAX_ERROR_BODY_LENGTH = 500;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export type ScrapeCreatorsFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type ScrapeCreatorsToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: ScrapeCreatorsFetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvedBaseURL(config: ScrapeCreatorsToolsConfig): string {
  const url = config.baseURL?.trim();
  if (url && url.length > 0) {
    return url.replace(/\/$/, "");
  }
  return SCRAPECREATORS_DEFAULT_BASE_URL;
}

function scrapeCreatorsHeaders(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey };
}

async function fetchJSON(
  config: ScrapeCreatorsToolsConfig,
  url: URL,
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: scrapeCreatorsHeaders(config.apiKey),
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

function resolveLimit(args: { limit?: number }): number {
  if (typeof args.limit === "number" && args.limit > 0) {
    return Math.min(Math.floor(args.limit), MAX_LIMIT);
  }
  return DEFAULT_LIMIT;
}

function stringField(
  rec: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function numberField(
  rec: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  return undefined;
}

function authorField(
  rec: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const containerKey of ["author", "user", "owner", "pinner"]) {
    const container = rec[containerKey];
    if (isRecord(container)) {
      const value = stringField(container, keys);
      if (value !== undefined) {
        return value;
      }
    }
    if (typeof container === "string" && container.length > 0) {
      return container;
    }
  }
  if (isRecord(rec.authorMeta)) {
    const value = stringField(rec.authorMeta, [
      "name",
      "nickName",
      "uniqueId",
      "unique_id",
    ]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

// ScrapeCreators wraps results under different top-level keys depending on the
// endpoint and occasionally returns a bare array. Try each candidate key in order.
function extractArray(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (!isRecord(data)) {
    throw new Error("ScrapeCreators response is not an object");
  }
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function parseTikTokPost(value: unknown): TikTokPost {
  if (!isRecord(value)) {
    throw new Error("TikTok item is not an object");
  }
  // The keyword search endpoint wraps each post under `aweme_info`.
  const rec = isRecord(value.aweme_info) ? value.aweme_info : value;
  const id = stringField(rec, ["aweme_id", "id"]) ?? "";
  const post: TikTokPost = { id };
  const url = stringField(rec, ["share_url", "webVideoUrl", "url"]);
  if (url !== undefined) {
    post.url = url;
  }
  const desc = stringField(rec, ["desc", "description"]);
  if (desc !== undefined) {
    post.desc = desc;
  }
  const createTime = numberField(rec, ["create_time", "createTime"]);
  if (createTime !== undefined) {
    post.createTime = createTime;
  }
  const stats = isRecord(rec.statistics) ? rec.statistics : rec;
  const likes = numberField(stats, ["digg_count", "diggCount", "like_count"]);
  if (likes !== undefined) {
    post.likes = likes;
  }
  const comments = numberField(stats, ["comment_count", "commentCount"]);
  if (comments !== undefined) {
    post.comments = comments;
  }
  const author = authorField(rec, [
    "unique_id",
    "uniqueId",
    "nickname",
    "name",
  ]);
  if (author !== undefined) {
    post.author = author;
  }
  return post;
}

function parseCaption(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (
    isRecord(value) &&
    typeof value.text === "string" &&
    value.text.length > 0
  ) {
    return value.text;
  }
  return undefined;
}

function parseInstagramPost(value: unknown): InstagramPost {
  if (!isRecord(value)) {
    throw new Error("Instagram item is not an object");
  }
  const rec = value;
  const post: InstagramPost = {};
  const code = stringField(rec, ["shortcode", "code", "shortCode"]);
  if (code !== undefined) {
    post.code = code;
  }
  const caption = parseCaption(rec.caption);
  if (caption !== undefined) {
    post.caption = caption;
  }
  if (typeof rec.taken_at === "number") {
    post.takenAt = rec.taken_at;
  } else {
    const takenAt = stringField(rec, [
      "taken_at",
      "timestamp",
      "taken_at_date",
    ]);
    if (takenAt !== undefined) {
      post.takenAt = takenAt;
    }
  }
  const likes = numberField(rec, ["like_count", "likesCount", "likes"]);
  if (likes !== undefined) {
    post.likes = likes;
  }
  const comments = numberField(rec, ["comment_count", "commentsCount"]);
  if (comments !== undefined) {
    post.comments = comments;
  }
  const author = authorField(rec, ["username", "handle"]);
  if (author !== undefined) {
    post.author = author;
  }
  return post;
}

function parseThreadsPost(value: unknown): ThreadsPost {
  if (!isRecord(value)) {
    throw new Error("Threads item is not an object");
  }
  const post: ThreadsPost = {};
  const code = stringField(value, ["code", "shortcode"]);
  if (code !== undefined) {
    post.code = code;
  }
  const text = stringField(value, ["text", "caption"]);
  if (text !== undefined) {
    post.text = text;
  }
  const takenAt = numberField(value, ["taken_at", "create_time"]);
  if (takenAt !== undefined) {
    post.taken_at = takenAt;
  }
  const likes = numberField(value, ["like_count", "likes"]);
  if (likes !== undefined) {
    post.like_count = likes;
  }
  const author = authorField(value, ["username", "handle"]);
  if (author !== undefined) {
    post.user = { username: author };
  }
  return post;
}

function parsePinterestPin(value: unknown): PinterestPin {
  if (!isRecord(value)) {
    throw new Error("Pinterest item is not an object");
  }
  const pin: PinterestPin = {};
  const id = stringField(value, ["id", "pin_id"]);
  if (id !== undefined) {
    pin.id = id;
  }
  const title = stringField(value, ["title", "grid_title"]);
  if (title !== undefined) {
    pin.title = title;
  }
  const description = stringField(value, ["description"]);
  if (description !== undefined) {
    pin.description = description;
  }
  const createdAt = stringField(value, ["created_at"]);
  if (createdAt !== undefined) {
    pin.created_at = createdAt;
  }
  const saves = numberField(value, ["save_count", "repin_count"]);
  if (saves !== undefined) {
    pin.save_count = saves;
  }
  const author = authorField(value, ["username", "full_name"]);
  if (author !== undefined) {
    pin.pinner = { username: author };
  }
  return pin;
}

export const SCRAPECREATORS_TIKTOK_DEFINITION: ToolDefinition = {
  name: "scrapecreators_tiktok",
  description:
    'Search TikTok posts and videos via ScrapeCreators. Use a specific query to scope results rather than pulling everything; defaults to 10 results. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "tiktok", author (when available), engagement: { upvotes, comments } }` (likes map to upvotes).',
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      limit: {
        type: "number",
        description: "Maximum number of results (1-100, default 10).",
      },
    },
    required: ["query"],
  },
};

export const SCRAPECREATORS_INSTAGRAM_DEFINITION: ToolDefinition = {
  name: "scrapecreators_instagram",
  description:
    'Search Instagram reels by keyword via ScrapeCreators. Use a specific query to scope results rather than pulling everything; defaults to 10 results. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "instagram", author (when available), engagement: { upvotes, comments } }` (likes map to upvotes).',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword to search.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (1-100, default 10).",
      },
    },
    required: ["query"],
  },
};

export const SCRAPECREATORS_THREADS_DEFINITION: ToolDefinition = {
  name: "scrapecreators_threads",
  description:
    'Search Threads posts via ScrapeCreators. Use a specific query to scope results rather than pulling everything; defaults to 10 results. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "threads", author (when available), engagement: { upvotes, comments: 0 } }` (likes map to upvotes; comments is always 0).',
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      limit: {
        type: "number",
        description: "Maximum number of results (1-100, default 10).",
      },
    },
    required: ["query"],
  },
};

export const SCRAPECREATORS_PINTEREST_DEFINITION: ToolDefinition = {
  name: "scrapecreators_pinterest",
  description:
    'Search Pinterest pins via ScrapeCreators. Use a specific query to scope results rather than pulling everything; defaults to 10 results. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "pinterest", author (when available), engagement: { upvotes, comments: 0 } }` (saves map to upvotes; comments is always 0).',
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      limit: {
        type: "number",
        description: "Maximum number of results (1-100, default 10).",
      },
    },
    required: ["query"],
  },
};

async function searchTikTok(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`scrapecreators_tiktok: ${parsed.summary}`);
  }
  const { query } = parsed;
  const limit = resolveLimit(parsed);
  const url = new URL(`${resolvedBaseURL(config)}/v1/tiktok/search/keyword`);
  url.searchParams.set("query", query);
  url.searchParams.set("sort_by", "relevance");
  const data = await fetchJSON(config, url, signal);
  const posts = extractArray(data, [
    "search_item_list",
    "aweme_list",
    "data",
    "posts",
  ])
    .slice(0, limit)
    .map(parseTikTokPost);
  return JSON.stringify(posts.map(normalizeTikTokPost), null, 2);
}

async function searchInstagram(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`scrapecreators_instagram: ${parsed.summary}`);
  }
  const { query } = parsed;
  const limit = resolveLimit(parsed);
  const url = new URL(`${resolvedBaseURL(config)}/v2/instagram/reels/search`);
  url.searchParams.set("query", query);
  const data = await fetchJSON(config, url, signal);
  const posts = extractArray(data, ["reels", "items", "data", "results"])
    .slice(0, limit)
    .map(parseInstagramPost);
  return JSON.stringify(posts.map(normalizeInstagramPost), null, 2);
}

async function searchThreads(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`scrapecreators_threads: ${parsed.summary}`);
  }
  const { query } = parsed;
  const limit = resolveLimit(parsed);
  const url = new URL(`${resolvedBaseURL(config)}/v1/threads/search`);
  url.searchParams.set("query", query);
  const data = await fetchJSON(config, url, signal);
  const posts = extractArray(data, [
    "posts",
    "threads",
    "items",
    "data",
    "search_results",
  ])
    .slice(0, limit)
    .map(parseThreadsPost);
  return JSON.stringify(posts.map(normalizeThreadsPost), null, 2);
}

async function searchPinterest(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`scrapecreators_pinterest: ${parsed.summary}`);
  }
  const { query } = parsed;
  const limit = resolveLimit(parsed);
  const url = new URL(`${resolvedBaseURL(config)}/v1/pinterest/search`);
  url.searchParams.set("query", query);
  const data = await fetchJSON(config, url, signal);
  const pins = extractArray(data, ["pins", "items", "data", "results"])
    .slice(0, limit)
    .map(parsePinterestPin);
  return JSON.stringify(pins.map(normalizePinterestPin), null, 2);
}

export function createScrapeCreatorsTools(
  config: ScrapeCreatorsToolsConfig,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: SCRAPECREATORS_TIKTOK_DEFINITION,
      handler: (args, signal) => searchTikTok(config, args, signal),
    },
    {
      kind: "string",
      definition: SCRAPECREATORS_INSTAGRAM_DEFINITION,
      handler: (args, signal) => searchInstagram(config, args, signal),
    },
    {
      kind: "string",
      definition: SCRAPECREATORS_THREADS_DEFINITION,
      handler: (args, signal) => searchThreads(config, args, signal),
    },
    {
      kind: "string",
      definition: SCRAPECREATORS_PINTEREST_DEFINITION,
      handler: (args, signal) => searchPinterest(config, args, signal),
    },
  ];
}

export const SCRAPECREATORS_HUB_TOOLS = {
  scrapecreators_tiktok: {
    sideEffect: "read" as const,
    definition: SCRAPECREATORS_TIKTOK_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_instagram: {
    sideEffect: "read" as const,
    definition: SCRAPECREATORS_INSTAGRAM_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_threads: {
    sideEffect: "read" as const,
    definition: SCRAPECREATORS_THREADS_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_pinterest: {
    sideEffect: "read" as const,
    definition: SCRAPECREATORS_PINTEREST_DEFINITION,
    providerName: "scrapecreators" as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
};
