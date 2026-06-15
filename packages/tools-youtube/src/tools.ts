import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeYouTubeVideo } from './normalize';
import type {
  YouTubeSearchItem,
  YouTubeSearchResponse,
  YouTubeVideoItem,
  YouTubeVideosResponse,
} from './types';

const YOUTUBE_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_DAYS = 30;
const MAX_RESULTS = 20;

export type YouTubeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type YouTubeToolsConfig = {
  apiKey: string;
  fetcher?: YouTubeFetch;
};

export const YOUTUBE_SEARCH_DEFINITION: ToolDefinition = {
  name: 'youtube_search',
  description:
    'Search YouTube videos from the last N days. Returns normalized research items with engagement data including views, likes, and comments.',
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

function parseSearchItem(value: unknown): YouTubeSearchItem {
  if (!isRecord(value)) {
    throw new Error('YouTube search item is not an object');
  }
  const id = isRecord(value.id) ? value.id : {};
  const snippet = isRecord(value.snippet) ? value.snippet : {};
  return {
    id: {
      kind: typeof id.kind === 'string' ? id.kind : '',
      videoId: typeof id.videoId === 'string' ? id.videoId : '',
    },
    snippet: {
      publishedAt: typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '',
      title: typeof snippet.title === 'string' ? snippet.title : '',
      description: typeof snippet.description === 'string' ? snippet.description : '',
      channelTitle: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '',
    },
  };
}

function parseSearchResponse(value: unknown): YouTubeSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { items: [] };
  }
  return { items: value.items.map(parseSearchItem) };
}

function parseVideoItem(value: unknown): YouTubeVideoItem {
  if (!isRecord(value)) {
    throw new Error('YouTube video item is not an object');
  }
  const stats = isRecord(value.statistics) ? value.statistics : {};
  return {
    id: typeof value.id === 'string' ? value.id : '',
    statistics: {
      viewCount: typeof stats.viewCount === 'string' ? stats.viewCount : undefined,
      likeCount: typeof stats.likeCount === 'string' ? stats.likeCount : undefined,
      commentCount: typeof stats.commentCount === 'string' ? stats.commentCount : undefined,
    },
  };
}

function parseVideosResponse(value: unknown): YouTubeVideosResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { items: [] };
  }
  return { items: value.items.map(parseVideoItem) };
}

async function fetchSearchResults(
  config: YouTubeToolsConfig,
  query: string,
  publishedAfter: string,
  signal: AbortSignal
): Promise<YouTubeSearchResponse> {
  const url = new URL(`${YOUTUBE_BASE_URL}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'video');
  url.searchParams.set('order', 'relevance');
  url.searchParams.set('publishedAfter', publishedAfter);
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  url.searchParams.set('key', config.apiKey);

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `YouTube search API error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const raw: unknown = await response.json();
  return parseSearchResponse(raw);
}

async function fetchVideoStatistics(
  config: YouTubeToolsConfig,
  videoIds: string[],
  signal: AbortSignal
): Promise<YouTubeVideosResponse> {
  if (videoIds.length === 0) {
    return { items: [] };
  }

  const url = new URL(`${YOUTUBE_BASE_URL}/videos`);
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', videoIds.join(','));
  url.searchParams.set('key', config.apiKey);

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `YouTube videos API error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const raw: unknown = await response.json();
  return parseVideosResponse(raw);
}

async function searchYouTube(
  config: YouTubeToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }
  const days =
    typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : DEFAULT_DAYS;

  const publishedAfter = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const searchResponse = await fetchSearchResults(config, query, publishedAfter, signal);

  if (searchResponse.items.length === 0) {
    return JSON.stringify([], null, 2);
  }

  const videoIds = searchResponse.items
    .map((item) => item.id.videoId)
    .filter((id) => id.length > 0);
  const videosResponse = await fetchVideoStatistics(config, videoIds, signal);

  const statsById = new Map<string, YouTubeVideoItem>();
  for (const videoItem of videosResponse.items) {
    statsById.set(videoItem.id, videoItem);
  }

  const items = searchResponse.items
    .filter((item) => item.id.videoId.length > 0)
    .map((item) => {
      const videoItem = statsById.get(item.id.videoId);
      return normalizeYouTubeVideo(item, videoItem?.statistics);
    });

  return JSON.stringify(items, null, 2);
}

export function createYouTubeTools(config: YouTubeToolsConfig): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: YOUTUBE_SEARCH_DEFINITION,
      handler: (args, signal) => searchYouTube(config, args, signal),
    },
  ];
}

export const YOUTUBE_HUB_TOOLS = {
  youtube_search: {
    definition: YOUTUBE_SEARCH_DEFINITION,
    providerName: 'youtube',
    createTools: (config: YouTubeToolsConfig) => createYouTubeTools(config),
  },
};
