import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizeXResult } from './normalize';
import type { XSearchResult } from './types';

const XAI_BASE_URL = 'https://api.x.ai';
const XAI_MODEL = 'grok-3-mini';
const MAX_RESULTS = 20;

export type XFetch = (input: string, init: RequestInit) => Promise<Response>;

export type XToolsConfig = {
  apiKey: string;
  baseURL?: string;
  fetcher?: XFetch;
};

export const X_SEARCH_DEFINITION: ToolDefinition = {
  name: 'x_search',
  description:
    'Search X/Twitter via xAI Grok live search. Returns a semantic sampling of recent posts and content for the query. Results are a semantic sampling by Grok, not stable post IDs — cite as approximate.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string.',
      },
    },
    required: ['query'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseXSearchResult(value: unknown): XSearchResult {
  if (!isRecord(value)) {
    throw new Error('xAI result item is not an object');
  }
  return {
    title: typeof value.title === 'string' ? value.title : '',
    url: typeof value.url === 'string' ? value.url : undefined,
    summary: typeof value.summary === 'string' ? value.summary : '',
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
    engagementSignal:
      typeof value.engagementSignal === 'string' ? value.engagementSignal : undefined,
  };
}

function parseXSearchResponse(content: string): XSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('xAI response content is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('xAI response content is not a JSON array');
  }
  return parsed.map(parseXSearchResult);
}

function resolveBaseUrl(config: XToolsConfig): string {
  return (config.baseURL ?? XAI_BASE_URL).replace(/\/$/, '');
}

async function searchX(
  config: XToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }

  const baseUrl = resolveBaseUrl(config);
  const endpoint = `${baseUrl}/v1/chat/completions`;

  const body = {
    model: XAI_MODEL,
    messages: [
      {
        role: 'system',
        content: `Return a JSON array of up to ${MAX_RESULTS} recent results for the query. Each item: {title, url, summary, publishedAt (ISO 8601), engagementSignal (string describing engagement)}. Return only the JSON array, no prose.`,
      },
      {
        role: 'user',
        content: query,
      },
    ],
    search_parameters: { mode: 'on' },
  };

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    throw new Error(`xAI API error: ${response.status} ${response.statusText}`);
  }

  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error('xAI response missing choices');
  }

  const firstChoice: unknown = data.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error('xAI response choice has no message');
  }

  const content = firstChoice.message.content;
  if (typeof content !== 'string') {
    throw new Error('xAI response message content is not a string');
  }

  const results = parseXSearchResponse(content);
  const normalized = results.map((item) => normalizeXResult(item, query));
  return JSON.stringify(normalized, null, 2);
}

export function createXTools(config: XToolsConfig): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: X_SEARCH_DEFINITION,
      handler: (args, signal) => searchX(config, args, signal),
    },
  ];
}

export const X_HUB_TOOLS = {
  x_search: {
    definition: X_SEARCH_DEFINITION,
    providerName: 'xai' as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createXTools({ apiKey: config.apiKey, baseURL: config.baseURL }),
  },
};
