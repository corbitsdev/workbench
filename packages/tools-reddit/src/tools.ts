import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeRedditPost } from './normalize';
import type { RedditPost, RedditPostData, RedditSearchResponse } from './types';

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const USER_AGENT = 'workbench/1.0';

export type RedditFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type RedditToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: RedditFetch;
};

const REDDIT_SEARCH_DEFINITION: ToolDefinition = {
  name: 'reddit_search',
  description:
    'Search Reddit posts across all subreddits. Returns normalized research items with upvote and comment counts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string.',
      },
      sort: {
        type: 'string',
        description: 'Sort order: relevance, new, or top (default relevance).',
      },
      t: {
        type: 'string',
        description: 'Time filter: hour, day, week, month, year, or all (default month).',
      },
      limit: {
        type: 'number',
        description: 'Number of results to return (max 100, default 25).',
      },
    },
    required: ['query'],
  },
};

const REDDIT_SUBREDDIT_SEARCH_DEFINITION: ToolDefinition = {
  name: 'reddit_subreddit_search',
  description:
    'Search Reddit posts within a specific subreddit. Returns normalized research items with upvote and comment counts.',
  inputSchema: {
    type: 'object',
    properties: {
      subreddit: {
        type: 'string',
        description: 'The subreddit name (without r/ prefix).',
      },
      query: {
        type: 'string',
        description: 'The search query string.',
      },
      sort: {
        type: 'string',
        description: 'Sort order: relevance, new, or top (default relevance).',
      },
      t: {
        type: 'string',
        description: 'Time filter: hour, day, week, month, year, or all (default month).',
      },
      limit: {
        type: 'number',
        description: 'Number of results to return (max 100, default 25).',
      },
    },
    required: ['subreddit', 'query'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRedditPost(value: unknown): RedditPost {
  if (!isRecord(value)) {
    throw new Error('Reddit post is not an object');
  }
  return {
    id: typeof value.id === 'string' ? value.id : String(value.id),
    title: typeof value.title === 'string' ? value.title : '',
    url: typeof value.url === 'string' ? value.url : '',
    permalink: typeof value.permalink === 'string' ? value.permalink : '',
    selftext: typeof value.selftext === 'string' ? value.selftext : '',
    created_utc: typeof value.created_utc === 'number' ? value.created_utc : 0,
    ups: typeof value.ups === 'number' ? value.ups : 0,
    num_comments: typeof value.num_comments === 'number' ? value.num_comments : 0,
    subreddit: typeof value.subreddit === 'string' ? value.subreddit : '',
  };
}

function parseRedditSearchResponse(value: unknown): RedditSearchResponse {
  if (!isRecord(value)) {
    throw new Error('Reddit response is not an object');
  }
  const data = value.data;
  if (!isRecord(data) || !Array.isArray(data.children)) {
    throw new Error('Reddit response is not a valid search response');
  }
  const children: RedditPostData[] = data.children.map((child: unknown) => {
    if (!isRecord(child)) {
      throw new Error('Reddit child is not an object');
    }
    return {
      kind: typeof child.kind === 'string' ? child.kind : '',
      data: parseRedditPost(child.data),
    };
  });
  return { data: { children } };
}

function buildSearchParams(args: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  params.set('q', query);
  params.set('type', 'link');

  const sort = typeof args.sort === 'string' ? args.sort : 'relevance';
  params.set('sort', sort);

  const t = typeof args.t === 'string' ? args.t : 'month';
  params.set('t', t);

  const limitRaw = typeof args.limit === 'number' ? args.limit : 25;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), 100);
  params.set('limit', String(limit));

  return params;
}

async function fetchRedditSearch(
  url: URL,
  config: RedditToolsConfig,
  signal: AbortSignal
): Promise<RedditSearchResponse> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'User-Agent': USER_AGENT,
    },
    signal,
  });

  if (response.status === 401) {
    // TODO: token refresh should be handled at the hub credential layer (OAuth callback flow)
    throw new Error('Reddit access token expired — user must re-authenticate');
  }

  if (!response.ok) {
    throw new Error(`Reddit API error: ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  return parseRedditSearchResponse(raw);
}

async function searchReddit(
  config: RedditToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const baseURL = config.baseURL ?? REDDIT_OAUTH_BASE;
  const url = new URL(`${baseURL}/search.json`);
  const params = buildSearchParams(args);
  params.forEach((value, key) => url.searchParams.set(key, value));

  const parsed = await fetchRedditSearch(url, config, signal);
  const items = parsed.data.children.map((child) => normalizeRedditPost(child.data));
  return JSON.stringify(items, null, 2);
}

async function searchSubreddit(
  config: RedditToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const subreddit = typeof args.subreddit === 'string' ? args.subreddit : '';
  if (subreddit.length === 0) {
    throw new Error('subreddit is required');
  }

  const baseURL = config.baseURL ?? REDDIT_OAUTH_BASE;
  const url = new URL(`${baseURL}/r/${subreddit}/search.json`);
  const params = buildSearchParams(args);
  params.forEach((value, key) => url.searchParams.set(key, value));
  url.searchParams.set('restrict_sr', 'true');

  const parsed = await fetchRedditSearch(url, config, signal);
  const items = parsed.data.children.map((child) => normalizeRedditPost(child.data));
  return JSON.stringify(items, null, 2);
}

export function createRedditTools(config: RedditToolsConfig): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: REDDIT_SEARCH_DEFINITION,
      handler: (args, signal) => searchReddit(config, args, signal),
    },
    {
      kind: 'string',
      definition: REDDIT_SUBREDDIT_SEARCH_DEFINITION,
      handler: (args, signal) => searchSubreddit(config, args, signal),
    },
  ];
}

export const REDDIT_HUB_TOOLS = {
  reddit_search: {
    definition: REDDIT_SEARCH_DEFINITION,
    providerName: 'reddit' as const,
    createTools: (config: { apiKey: string; baseURL: string }) => createRedditTools(config),
  },
  reddit_subreddit_search: {
    definition: REDDIT_SUBREDDIT_SEARCH_DEFINITION,
    providerName: 'reddit' as const,
    createTools: (config: { apiKey: string; baseURL: string }) => createRedditTools(config),
  },
};
