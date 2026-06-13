import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { normalizePolymarketMarket } from './normalize';
import type { PolymarketMarket } from './types';

const POLYMARKET_API_BASE = 'https://gamma-api.polymarket.com';

export type PolymarketFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type PolymarketToolsConfig = {
  fetcher?: PolymarketFetch;
};

export const POLYMARKET_ODDS_DEFINITION: ToolDefinition = {
  name: 'polymarket_odds',
  description:
    'Search active Polymarket prediction markets matching a query. Returns normalized research items with market volume as engagement.',
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

function parsePolymarketMarket(value: unknown): PolymarketMarket {
  if (!isRecord(value)) {
    throw new Error('Polymarket market item is not an object');
  }
  const outcomePrices = Array.isArray(value.outcomePrices)
    ? value.outcomePrices.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    id: typeof value.id === 'string' ? value.id : String(value.id),
    question: typeof value.question === 'string' ? value.question : '',
    outcomePrices,
    volume24hr: typeof value.volume24hr === 'number' ? value.volume24hr : undefined,
    endDate: typeof value.endDate === 'string' ? value.endDate : undefined,
    conditionId: typeof value.conditionId === 'string' ? value.conditionId : '',
  };
}

async function searchPolymarket(
  config: PolymarketToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    throw new Error('query is required');
  }

  const url = new URL(`${POLYMARKET_API_BASE}/markets`);
  url.searchParams.set('q', query);
  url.searchParams.set('active', 'true');
  url.searchParams.set('limit', '20');

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  const markets = Array.isArray(raw) ? raw.map(parsePolymarketMarket) : [];
  const items = markets.map(normalizePolymarketMarket);

  return JSON.stringify(items, null, 2);
}

export function createPolymarketTools(config: PolymarketToolsConfig = {}): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: POLYMARKET_ODDS_DEFINITION,
      handler: (args, signal) => searchPolymarket(config, args, signal),
    },
  ];
}

export const POLYMARKET_HUB_TOOLS = {
  polymarket_odds: {
    definition: POLYMARKET_ODDS_DEFINITION,
    createTools: () => createPolymarketTools(),
  },
};
