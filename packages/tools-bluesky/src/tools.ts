import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeBlueskyPost } from './normalize';
import type { BlueskyPost, BlueskySearchResponse } from './types';

const BLUESKY_SEARCH_URL = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';
const DEFAULT_DAYS = 30;
const MAX_ERROR_BODY_LENGTH = 500;

export type BlueskyFetch = (url: string, init?: RequestInit) => Promise<Response>;

// Bluesky search runs against the unauthenticated AppView (public.api.bsky.app),
// which needs no credential. Authenticated reads would require a real AT Protocol
// createSession -> JWT bearer flow (not HTTP Basic); until there's a need for it,
// this tool is public-only and takes no auth config.
export type BlueskyToolsConfig = {
  fetcher?: BlueskyFetch;
};

export const BLUESKY_SEARCH_DEFINITION: ToolDefinition = {
  name: 'bluesky_search',
  description:
    'Search Bluesky posts from the last N days. Returns normalized research items with engagement data (likes, replies, reposts).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string.',
      },
      days: {
        type: 'number',
        description: 'Number of days to look back (default 30).',
      },
    },
    required: ['query'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBlueskyPost(value: unknown): BlueskyPost {
  if (!isRecord(value)) {
    throw new Error('Bluesky post is not an object');
  }
  const author = value.author;
  if (!isRecord(author)) {
    throw new Error('Bluesky post author is missing');
  }
  const record = value.record;
  if (!isRecord(record)) {
    throw new Error('Bluesky post record is missing');
  }
  const parsedAuthor: BlueskyPost['author'] = {
    did: typeof author.did === 'string' ? author.did : '',
    handle: typeof author.handle === 'string' ? author.handle : '',
  };
  if (typeof author.displayName === 'string') {
    parsedAuthor.displayName = author.displayName;
  }
  return {
    uri: typeof value.uri === 'string' ? value.uri : '',
    cid: typeof value.cid === 'string' ? value.cid : '',
    author: parsedAuthor,
    record: {
      $type: typeof record.$type === 'string' ? record.$type : 'app.bsky.feed.post',
      text: typeof record.text === 'string' ? record.text : '',
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    },
    likeCount: typeof value.likeCount === 'number' ? value.likeCount : 0,
    replyCount: typeof value.replyCount === 'number' ? value.replyCount : 0,
    repostCount: typeof value.repostCount === 'number' ? value.repostCount : 0,
    indexedAt: typeof value.indexedAt === 'string' ? value.indexedAt : new Date().toISOString(),
  };
}

function parseBlueskySearchResponse(value: unknown): BlueskySearchResponse {
  if (!isRecord(value) || !Array.isArray(value.posts)) {
    throw new Error('Bluesky response is not a valid search response');
  }
  return { posts: value.posts.map(parseBlueskyPost) };
}

function isWithinDaysWindow(dateString: string, cutoffMs: number): boolean {
  const postTime = new Date(dateString).getTime();
  return postTime >= cutoffMs;
}

async function searchBluesky(
  config: BlueskyToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const days =
    typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : DEFAULT_DAYS;
  const cutoffMs = Date.now() - days * 86400 * 1000;

  const url = new URL(BLUESKY_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'top');

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.length > 0 ? `: ${body.slice(0, MAX_ERROR_BODY_LENGTH)}` : '';
    throw new Error(`Bluesky API error: ${response.status} ${response.statusText}${detail}`);
  }

  const raw: unknown = await response.json();
  const parsed = parseBlueskySearchResponse(raw);

  const filteredPosts = parsed.posts.filter((post) => {
    const dateToCheck = post.indexedAt.length > 0 ? post.indexedAt : post.record.createdAt;
    return isWithinDaysWindow(dateToCheck, cutoffMs);
  });

  if (filteredPosts.length === 0) {
    return JSON.stringify([], null, 2);
  }

  const items = filteredPosts.map(normalizeBlueskyPost);
  return JSON.stringify(items, null, 2);
}

export function createBlueskyTools(config: BlueskyToolsConfig = {}): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: BLUESKY_SEARCH_DEFINITION,
      handler: (args, signal) => searchBluesky(config, args, signal),
    },
  ];
}

export const BLUESKY_HUB_TOOLS = {
  bluesky_search: {
    definition: BLUESKY_SEARCH_DEFINITION,
    createTools: () => createBlueskyTools(),
  },
};
