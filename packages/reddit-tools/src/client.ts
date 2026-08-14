// A minimal Reddit search client. Reddit's own public JSON endpoints get
// IP-blocked from datacenter hosts, and its authenticated API needs an
// OAuth flow this platform does not run server-side — so, matching the
// OG gtm-workbench's `tools-reddit` package, this client proxies through
// ScrapeCreators (`https://api.scrapecreators.com`, header
// `x-api-key`) rather than Reddit directly. There is no separate Reddit
// credential: this reuses the same ScrapeCreators API key any other
// ScrapeCreators-backed integration in this workspace would use.
import { type } from "arktype";

export const RedditPost = type({
  title: "string",
  url: "string",
  permalink: "string",
  subreddit: "string",
  createdAt: "string",
  upvotes: "number",
  numComments: "number",
});
export type RedditPost = typeof RedditPost.infer;

export interface RedditClientConfig {
  readonly apiKey: string;
  /** Override for tests; defaults to ScrapeCreators' real base URL. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RedditSearchParams {
  readonly query: string;
  readonly sort?: string;
  readonly timeframe?: string;
}

export interface RedditSubredditSearchParams extends RedditSearchParams {
  readonly subreddit: string;
}

const DEFAULT_BASE_URL = "https://api.scrapecreators.com";
const MAX_ERROR_BODY_LENGTH = 500;

interface RawRedditPost {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly permalink?: unknown;
  readonly subreddit?: unknown;
  readonly created_utc?: unknown;
  readonly created_at?: unknown;
  readonly ups?: unknown;
  readonly upvotes?: unknown;
  readonly num_comments?: unknown;
  readonly comments?: unknown;
}

function extractRawPosts(body: unknown): readonly RawRedditPost[] {
  if (Array.isArray(body)) return body as RawRedditPost[];
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["posts", "data", "results"]) {
      const value = record[key];
      if (Array.isArray(value)) return value as RawRedditPost[];
    }
  }
  return [];
}

function toCreatedAt(raw: RawRedditPost): string | undefined {
  if (typeof raw.created_at === "string") return raw.created_at;
  if (typeof raw.created_utc === "number") {
    return new Date(raw.created_utc * 1000).toISOString();
  }
  return undefined;
}

function parseRawPost(raw: RawRedditPost): RedditPost | undefined {
  const createdAt = toCreatedAt(raw);
  if (
    typeof raw.title !== "string" ||
    typeof raw.url !== "string" ||
    typeof raw.permalink !== "string" ||
    typeof raw.subreddit !== "string" ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const upvotes = raw.ups ?? raw.upvotes;
  const numComments = raw.num_comments ?? raw.comments;
  const parsed = RedditPost({
    title: raw.title,
    url: raw.url,
    permalink: raw.permalink,
    subreddit: raw.subreddit,
    createdAt,
    upvotes: typeof upvotes === "number" ? upvotes : 0,
    numComments: typeof numComments === "number" ? numComments : 0,
  });
  return parsed instanceof type.errors ? undefined : parsed;
}

async function fetchPosts(
  config: RedditClientConfig,
  path: string,
  params: Record<string, string | undefined>,
): Promise<readonly RedditPost[]> {
  const url = new URL(path, config.baseUrl ?? DEFAULT_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url.toString(), {
    headers: { "x-api-key": config.apiKey },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail =
      body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : "";
    throw new Error(
      `ScrapeCreators Reddit request failed: ${response.status} ${response.statusText}${detail}`,
    );
  }
  const body: unknown = await response.json();
  const posts = extractRawPosts(body)
    .map(parseRawPost)
    .filter((post): post is RedditPost => post !== undefined);
  return posts;
}

/**
 * Searches Reddit across all subreddits for a query. Throws on any
 * transport, HTTP, or shape failure — callers that need graceful
 * degradation (e.g. the reddit-tools tool bundle) catch at their own
 * boundary rather than this client silently swallowing errors.
 */
export function searchReddit(
  config: RedditClientConfig,
  params: RedditSearchParams,
): Promise<readonly RedditPost[]> {
  return fetchPosts(config, "/v1/reddit/search", {
    query: params.query,
    sort: params.sort,
    timeframe: params.timeframe,
  });
}

/**
 * Searches one subreddit for a query. Same failure contract as
 * `searchReddit`.
 */
export function searchSubreddit(
  config: RedditClientConfig,
  params: RedditSubredditSearchParams,
): Promise<readonly RedditPost[]> {
  return fetchPosts(config, "/v1/reddit/subreddit/search", {
    subreddit: params.subreddit,
    query: params.query,
    sort: params.sort,
    timeframe: params.timeframe,
  });
}
