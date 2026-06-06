import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

export type ExaFetch = (input: string, init: RequestInit) => Promise<Response>;

export type ExaToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: ExaFetch;
};

type ExaSearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  summary?: string;
};

type ExaSearchResponse = {
  results: ExaSearchResult[];
};

const DEFAULT_BASE_URL = 'https://api.exa.ai';
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 25;

function exaHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function optionalPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSearchResult(value: unknown): ExaSearchResult {
  if (!isRecord(value)) {
    throw new Error('Exa response contains an invalid search result');
  }

  const title = typeof value.title === 'string' ? value.title : '';
  const url = typeof value.url === 'string' ? value.url : '';
  const publishedDate = optionalString(value.publishedDate);
  const author = optionalString(value.author);
  const text = optionalString(value.text);
  const summary = optionalString(value.summary);

  return {
    title,
    url,
    ...(publishedDate !== null ? { publishedDate } : {}),
    ...(author !== null ? { author } : {}),
    ...(text !== null ? { text } : {}),
    ...(summary !== null ? { summary } : {}),
  };
}

function parseSearchResponse(value: unknown): ExaSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('Exa response contains an invalid search result list');
  }

  return {
    results: value.results.map(parseSearchResult),
  };
}

function validateConfig(config: ExaToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error('Exa apiKey is required');
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error('Exa baseUrl must be a valid URL');
    }
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

async function fetchExaJSON(config: ExaToolsConfig, url: URL, body: unknown, signal: AbortSignal) {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: exaHeaders(config.apiKey),
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(await response.text().catch(() => ''));
    const detail = response.statusText || bodyText;
    throw new Error(`Exa API error: ${response.status} ${detail ?? ''}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function searchExa(
  config: ExaToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
) {
  const query = optionalString(args.query);
  if (query === null) {
    throw new Error('query is required');
  }

  const numResults = optionalPositiveInteger(args.numResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const type = optionalString(args.type);
  const includeDomains = optionalStringArray(args.includeDomains);
  const excludeDomains = optionalStringArray(args.excludeDomains);

  const url = new URL(`${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}/search`);

  const body: Record<string, unknown> = {
    query,
    numResults,
  };

  if (type !== null) {
    body.type = type;
  }
  if (includeDomains !== null) {
    body.includeDomains = includeDomains;
  }
  if (excludeDomains !== null) {
    body.excludeDomains = excludeDomains;
  }

  return parseSearchResponse(await fetchExaJSON(config, url, body, signal));
}

export const EXA_SEARCH_DEFINITION: ToolDefinition = {
  name: 'exa_search',
  description:
    'Search the web using Exa. Returns a list of relevant results with title, URL, and optional text/summary. Use this to find current information, research topics, or verify facts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string.',
      },
      numResults: {
        type: 'number',
        description: 'Maximum number of results to return (1-25, default 5).',
      },
      type: {
        type: 'string',
        description: 'Search type: auto, instant, fast, deep-lite, deep, deep-reasoning. Default is auto.',
      },
      includeDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of domains to include in results.',
      },
      excludeDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of domains to exclude from results.',
      },
    },
    required: ['query'],
  },
};

export function createExaTools(config: ExaToolsConfig): AgentTool[] {
  validateConfig(config);

  return [
    {
      kind: 'string',
      definition: EXA_SEARCH_DEFINITION,
      handler: async (args, signal) => jsonResult(await searchExa(config, args, signal)),
    },
  ];
}
