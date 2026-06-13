import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import {
  normalizeTikTokPost,
  normalizeInstagramPost,
  normalizeThreadsPost,
  normalizePinterestPin,
} from './normalize';
import type { TikTokPost, InstagramPost, ThreadsPost, PinterestPin } from './types';

// Endpoints verified against https://docs.scrapecreators.com — update if the API changes.
export const SCRAPECREATORS_DEFAULT_BASE_URL = 'https://api.scrapecreators.com';

export type ScrapeCreatorsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ScrapeCreatorsToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: ScrapeCreatorsFetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolvedBaseURL(config: ScrapeCreatorsToolsConfig): string {
  const url = config.baseURL?.trim();
  if (url && url.length > 0) {
    return url.replace(/\/$/, '');
  }
  return SCRAPECREATORS_DEFAULT_BASE_URL;
}

function scrapeCreatorsHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey };
}

async function fetchJSON(
  config: ScrapeCreatorsToolsConfig,
  url: URL,
  signal: AbortSignal
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: scrapeCreatorsHeaders(config.apiKey),
    signal,
  });
  if (!response.ok) {
    throw new Error(`ScrapeCreators API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function parseTikTokPost(value: unknown): TikTokPost {
  if (!isRecord(value)) {
    throw new Error('TikTok item is not an object');
  }
  const id = typeof value.id === 'string' ? value.id : String(value.id ?? '');
  const post: TikTokPost = { id };
  if (typeof value.webVideoUrl === 'string') {
    post.webVideoUrl = value.webVideoUrl;
  }
  if (typeof value.desc === 'string') {
    post.desc = value.desc;
  }
  if (typeof value.createTime === 'number') {
    post.createTime = value.createTime;
  }
  if (typeof value.diggCount === 'number') {
    post.diggCount = value.diggCount;
  }
  if (isRecord(value.authorMeta) && typeof value.authorMeta.name === 'string') {
    post.authorMeta = { name: value.authorMeta.name };
  }
  return post;
}

function parseInstagramPost(value: unknown): InstagramPost {
  if (!isRecord(value)) {
    throw new Error('Instagram item is not an object');
  }
  const post: InstagramPost = {};
  if (typeof value.shortCode === 'string') {
    post.shortCode = value.shortCode;
  }
  if (typeof value.caption === 'string') {
    post.caption = value.caption;
  }
  if (typeof value.timestamp === 'string') {
    post.timestamp = value.timestamp;
  }
  if (typeof value.likesCount === 'number') {
    post.likesCount = value.likesCount;
  }
  if (typeof value.ownerUsername === 'string') {
    post.ownerUsername = value.ownerUsername;
  }
  return post;
}

function parseThreadsPost(value: unknown): ThreadsPost {
  if (!isRecord(value)) {
    throw new Error('Threads item is not an object');
  }
  const post: ThreadsPost = {};
  if (typeof value.code === 'string') {
    post.code = value.code;
  }
  if (typeof value.text === 'string') {
    post.text = value.text;
  }
  if (typeof value.taken_at === 'number') {
    post.taken_at = value.taken_at;
  }
  if (typeof value.like_count === 'number') {
    post.like_count = value.like_count;
  }
  if (isRecord(value.user) && typeof value.user.username === 'string') {
    post.user = { username: value.user.username };
  }
  return post;
}

function parsePinterestPin(value: unknown): PinterestPin {
  if (!isRecord(value)) {
    throw new Error('Pinterest item is not an object');
  }
  const pin: PinterestPin = {};
  if (typeof value.id === 'string') {
    pin.id = value.id;
  }
  if (typeof value.title === 'string') {
    pin.title = value.title;
  }
  if (typeof value.description === 'string') {
    pin.description = value.description;
  }
  if (typeof value.created_at === 'string') {
    pin.created_at = value.created_at;
  }
  if (typeof value.save_count === 'number') {
    pin.save_count = value.save_count;
  }
  if (isRecord(value.pinner) && typeof value.pinner.username === 'string') {
    pin.pinner = { username: value.pinner.username };
  }
  return pin;
}

function parsePostsArray<T>(data: unknown, key: string, parseItem: (v: unknown) => T): T[] {
  if (!isRecord(data)) {
    throw new Error(`ScrapeCreators response is not an object`);
  }
  const items = data[key];
  if (!Array.isArray(items)) {
    if (Array.isArray(data)) {
      return (data as unknown[]).map(parseItem);
    }
    return [];
  }
  return items.map(parseItem);
}

export const SCRAPECREATORS_TIKTOK_DEFINITION: ToolDefinition = {
  name: 'scrapecreators_tiktok',
  description:
    'Search TikTok posts and videos via ScrapeCreators. Returns normalized research items with engagement data (likes).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: 'Maximum number of results (default 20).' },
    },
    required: ['query'],
  },
};

export const SCRAPECREATORS_INSTAGRAM_DEFINITION: ToolDefinition = {
  name: 'scrapecreators_instagram',
  description:
    'Search Instagram posts and reels by hashtag or keyword via ScrapeCreators. Returns normalized research items.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Hashtag (without #) or keyword to search.',
      },
      limit: { type: 'number', description: 'Maximum number of results (default 20).' },
    },
    required: ['query'],
  },
};

export const SCRAPECREATORS_THREADS_DEFINITION: ToolDefinition = {
  name: 'scrapecreators_threads',
  description:
    'Search Threads posts via ScrapeCreators. Returns normalized research items with engagement data.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: 'Maximum number of results (default 20).' },
    },
    required: ['query'],
  },
};

export const SCRAPECREATORS_PINTEREST_DEFINITION: ToolDefinition = {
  name: 'scrapecreators_pinterest',
  description:
    'Search Pinterest pins via ScrapeCreators. Returns normalized research items with save counts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: 'Maximum number of results (default 20).' },
    },
    required: ['query'],
  },
};

async function searchTikTok(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const url = new URL(`${resolvedBaseURL(config)}/v1/tiktok/search/posts`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', limit.toString());
  const data = await fetchJSON(config, url, signal);
  const posts = parsePostsArray(data, 'posts', parseTikTokPost);
  return JSON.stringify(posts.map(normalizeTikTokPost), null, 2);
}

async function searchInstagram(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const url = new URL(`${resolvedBaseURL(config)}/v1/instagram/hashtag/posts`);
  url.searchParams.set('hashtag', query);
  url.searchParams.set('limit', limit.toString());
  const data = await fetchJSON(config, url, signal);
  const posts = parsePostsArray(data, 'posts', parseInstagramPost);
  return JSON.stringify(posts.map(normalizeInstagramPost), null, 2);
}

async function searchThreads(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const url = new URL(`${resolvedBaseURL(config)}/v1/threads/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', limit.toString());
  const data = await fetchJSON(config, url, signal);
  const posts = parsePostsArray(data, 'posts', parseThreadsPost);
  return JSON.stringify(posts.map(normalizeThreadsPost), null, 2);
}

async function searchPinterest(
  config: ScrapeCreatorsToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const url = new URL(`${resolvedBaseURL(config)}/v1/pinterest/search/pins`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', limit.toString());
  const data = await fetchJSON(config, url, signal);
  const pins = parsePostsArray(data, 'pins', parsePinterestPin);
  return JSON.stringify(pins.map(normalizePinterestPin), null, 2);
}

export function createScrapeCreatorsTools(config: ScrapeCreatorsToolsConfig): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: SCRAPECREATORS_TIKTOK_DEFINITION,
      handler: (args, signal) => searchTikTok(config, args, signal),
    },
    {
      kind: 'string',
      definition: SCRAPECREATORS_INSTAGRAM_DEFINITION,
      handler: (args, signal) => searchInstagram(config, args, signal),
    },
    {
      kind: 'string',
      definition: SCRAPECREATORS_THREADS_DEFINITION,
      handler: (args, signal) => searchThreads(config, args, signal),
    },
    {
      kind: 'string',
      definition: SCRAPECREATORS_PINTEREST_DEFINITION,
      handler: (args, signal) => searchPinterest(config, args, signal),
    },
  ];
}

export const SCRAPECREATORS_HUB_TOOLS = {
  scrapecreators_tiktok: {
    definition: SCRAPECREATORS_TIKTOK_DEFINITION,
    providerName: 'scrapecreators' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_instagram: {
    definition: SCRAPECREATORS_INSTAGRAM_DEFINITION,
    providerName: 'scrapecreators' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_threads: {
    definition: SCRAPECREATORS_THREADS_DEFINITION,
    providerName: 'scrapecreators' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
  scrapecreators_pinterest: {
    definition: SCRAPECREATORS_PINTEREST_DEFINITION,
    providerName: 'scrapecreators' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createScrapeCreatorsTools(config),
  },
};
