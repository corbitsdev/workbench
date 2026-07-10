import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { normalizeBlueskyPost } from "./normalize";
import type { BlueskyPost, BlueskySearchResponse } from "./types";

// The public AppView now gates searchPosts with 403 unless a User-Agent is set.
// Authenticated search uses bsky.social PDS + AppView (bsky.network) with an
// AT Protocol app-password session. The public AppView path remains as a fallback
// when no credentials are configured.
const BLUESKY_PUBLIC_SEARCH_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const BLUESKY_AUTHED_SEARCH_URL =
  "https://bsky.network/xrpc/app.bsky.feed.searchPosts";
const BLUESKY_CREATE_SESSION_URL =
  "https://bsky.social/xrpc/com.atproto.server.createSession";
const BLUESKY_USER_AGENT = "gtm-workbench-bluesky/1.0";
const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ERROR_BODY_LENGTH = 500;

export type BlueskyFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type BlueskyToolsConfig = {
  fetcher?: BlueskyFetch;
  /**
   * AT Protocol handle (e.g. alice.bsky.social). When set alongside appPassword,
   * search requests use an authenticated PDS session instead of the public AppView.
   */
  handle?: string;
  /**
   * AT Protocol app-password. Never the account password; generate one under
   * Settings → App Passwords on bsky.app.
   */
  appPassword?: string;
};

export const BLUESKY_SEARCH_DEFINITION: ToolDefinition = {
  name: "bluesky_search",
  description:
    'Search Bluesky posts from the last N days. Scope the search with a specific query and the days window rather than pulling everything; returns up to 25 posts by default. Returns a JSON array of research items — each `{ url, title, publishedAt (ISO 8601), source: "bluesky", engagement: { upvotes, comments, shares } }`, where likes map to upvotes, replies to comments, and reposts to shares.',
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
        description: "Maximum number of posts to return (1-100, default 25).",
      },
    },
    required: ["query"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBlueskyPost(value: unknown): BlueskyPost {
  if (!isRecord(value)) {
    throw new Error("Bluesky post is not an object");
  }
  const author = value.author;
  if (!isRecord(author)) {
    throw new Error("Bluesky post author is missing");
  }
  const record = value.record;
  if (!isRecord(record)) {
    throw new Error("Bluesky post record is missing");
  }
  const parsedAuthor: BlueskyPost["author"] = {
    did: typeof author.did === "string" ? author.did : "",
    handle: typeof author.handle === "string" ? author.handle : "",
  };
  if (typeof author.displayName === "string") {
    parsedAuthor.displayName = author.displayName;
  }
  return {
    uri: typeof value.uri === "string" ? value.uri : "",
    cid: typeof value.cid === "string" ? value.cid : "",
    author: parsedAuthor,
    record: {
      $type:
        typeof record.$type === "string" ? record.$type : "app.bsky.feed.post",
      text: typeof record.text === "string" ? record.text : "",
      createdAt:
        typeof record.createdAt === "string"
          ? record.createdAt
          : new Date().toISOString(),
    },
    likeCount: typeof value.likeCount === "number" ? value.likeCount : 0,
    replyCount: typeof value.replyCount === "number" ? value.replyCount : 0,
    repostCount: typeof value.repostCount === "number" ? value.repostCount : 0,
    indexedAt:
      typeof value.indexedAt === "string"
        ? value.indexedAt
        : new Date().toISOString(),
  };
}

function parseBlueskySearchResponse(value: unknown): BlueskySearchResponse {
  if (!isRecord(value) || !Array.isArray(value.posts)) {
    throw new Error("Bluesky response is not a valid search response");
  }
  return { posts: value.posts.map(parseBlueskyPost) };
}

function isWithinDaysWindow(dateString: string, cutoffMs: number): boolean {
  const postTime = new Date(dateString).getTime();
  return postTime >= cutoffMs;
}

type AtSession = {
  accessJwt: string;
};

function parseAtSession(value: unknown): AtSession {
  if (typeof value !== "object" || value === null) {
    throw new Error("Bluesky createSession response is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.accessJwt !== "string") {
    throw new Error("Bluesky createSession response missing accessJwt");
  }
  return { accessJwt: record.accessJwt };
}

async function createAtSession(
  fetcher: BlueskyFetch,
  handle: string,
  appPassword: string,
  signal: AbortSignal,
): Promise<AtSession> {
  const response = await fetcher(BLUESKY_CREATE_SESSION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": BLUESKY_USER_AGENT,
    },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail =
      body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : "";
    throw new Error(
      `Bluesky createSession error: ${response.status} ${response.statusText}${detail}`,
    );
  }
  const raw: unknown = await response.json();
  return parseAtSession(raw);
}

async function executeSearchRequest(
  fetcher: BlueskyFetch,
  searchUrl: URL,
  accessJwt: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": BLUESKY_USER_AGENT };
  if (accessJwt !== null) {
    headers["Authorization"] = `Bearer ${accessJwt}`;
  }
  return fetcher(searchUrl.toString(), { headers, signal });
}

async function searchBluesky(
  config: BlueskyToolsConfig,
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
  const cutoffMs = Date.now() - days * 86400 * 1000;
  const limit =
    typeof args.limit === "number" &&
    Number.isInteger(args.limit) &&
    args.limit > 0
      ? Math.min(args.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const fetcher = config.fetcher ?? fetch;
  const hasCredentials =
    typeof config.handle === "string" &&
    config.handle.length > 0 &&
    typeof config.appPassword === "string" &&
    config.appPassword.length > 0;

  const searchUrl = new URL(
    hasCredentials ? BLUESKY_AUTHED_SEARCH_URL : BLUESKY_PUBLIC_SEARCH_URL,
  );
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", String(limit));
  searchUrl.searchParams.set("sort", "top");

  if (!hasCredentials) {
    const response = await executeSearchRequest(
      fetcher,
      searchUrl,
      null,
      signal,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail =
        body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : "";
      throw new Error(
        `Bluesky API error: ${response.status} ${response.statusText}${detail}`,
      );
    }
    return finishSearch(response, cutoffMs);
  }

  const handle = config.handle as string;
  const appPassword = config.appPassword as string;

  let session = await createAtSession(fetcher, handle, appPassword, signal);
  let response = await executeSearchRequest(
    fetcher,
    searchUrl,
    session.accessJwt,
    signal,
  );

  if (response.status === 401) {
    session = await createAtSession(fetcher, handle, appPassword, signal);
    response = await executeSearchRequest(
      fetcher,
      searchUrl,
      session.accessJwt,
      signal,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail =
      body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : "";
    throw new Error(
      `Bluesky API error: ${response.status} ${response.statusText}${detail}`,
    );
  }
  return finishSearch(response, cutoffMs);
}

async function finishSearch(
  response: Response,
  cutoffMs: number,
): Promise<string> {
  const raw: unknown = await response.json();
  const parsed = parseBlueskySearchResponse(raw);

  const filteredPosts = parsed.posts.filter((post) => {
    const dateToCheck =
      post.indexedAt.length > 0 ? post.indexedAt : post.record.createdAt;
    return isWithinDaysWindow(dateToCheck, cutoffMs);
  });

  if (filteredPosts.length === 0) {
    return JSON.stringify([], null, 2);
  }

  const items = filteredPosts.map(normalizeBlueskyPost);
  return JSON.stringify(items, null, 2);
}

export function createBlueskyTools(
  config: BlueskyToolsConfig = {},
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: BLUESKY_SEARCH_DEFINITION,
      handler: (args, signal) => searchBluesky(config, args, signal),
    },
  ];
}

export const BLUESKY_HUB_TOOLS = {
  bluesky_search: {
    sideEffect: "read" as const,
    definition: BLUESKY_SEARCH_DEFINITION,
    providerName: "bluesky" as const,
    createTools: (credential: { apiKey: string; baseURL: string }) =>
      createBlueskyTools({
        appPassword: credential.apiKey,
        handle: credential.baseURL,
      }),
  },
};
