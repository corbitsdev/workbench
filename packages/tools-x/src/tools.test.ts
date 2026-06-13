import { describe, expect, it } from 'bun:test';
import { X_HUB_TOOLS, createXTools } from './tools';

describe('X_HUB_TOOLS', () => {
  it('exports x_search entry', () => {
    expect(X_HUB_TOOLS.x_search).toBeDefined();
  });

  it('x_search has providerName xai', () => {
    expect(X_HUB_TOOLS.x_search.providerName).toBe('xai');
  });

  it('x_search definition name is x_search', () => {
    expect(X_HUB_TOOLS.x_search.definition.name).toBe('x_search');
  });
});

describe('createXTools / x_search handler', () => {
  const apiResults = [
    {
      title: 'AI funding surges',
      url: 'https://x.com/user/status/789',
      summary: 'AI investment hits record high.',
      publishedAt: '2025-01-15T09:00:00Z',
      engagementSignal: '10k impressions',
    },
  ];

  const mockResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify(apiResults),
        },
      },
    ],
  };

  function makeFetcher(response: unknown) {
    return async (_url: string, _init: RequestInit): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as unknown as Response;
    };
  }

  function findStringTool(tools: ReturnType<typeof createXTools>, name: string) {
    const tool = tools.find((t) => t.definition.name === name);
    if (tool === undefined || tool.kind !== 'string') {
      throw new Error(`string tool ${name} not found`);
    }
    return tool;
  }

  it('returns normalized items with author x-grok', async () => {
    const tools = createXTools({ apiKey: 'test-key', fetcher: makeFetcher(mockResponse) });
    const xSearch = findStringTool(tools, 'x_search');

    const raw = await xSearch.handler({ query: 'AI funding' }, new AbortController().signal);
    const items: unknown[] = JSON.parse(raw);
    expect(items.length).toBe(1);

    const item = items[0] as Record<string, unknown>;
    expect(item.author).toBe('x-grok');
    expect(item.url).toBe('https://x.com/user/status/789');
    expect(item.title).toBe('AI funding surges');
    expect(item.publishedAt).toBe('2025-01-15T09:00:00Z');
    expect(item.provenance).toBe('degraded');
  });

  it('throws when query is missing', async () => {
    const tools = createXTools({ apiKey: 'test-key', fetcher: makeFetcher(mockResponse) });
    const xSearch = findStringTool(tools, 'x_search');
    expect(xSearch.handler({}, new AbortController().signal)).rejects.toThrow('query is required');
  });

  it('throws on non-ok response', async () => {
    const errorFetcher = async (): Promise<Response> =>
      ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({}),
        text: async () => '',
      }) as unknown as Response;

    const tools = createXTools({ apiKey: 'test-key', fetcher: errorFetcher });
    const xSearch = findStringTool(tools, 'x_search');
    expect(xSearch.handler({ query: 'test' }, new AbortController().signal)).rejects.toThrow(
      'xAI API error: 429'
    );
  });
});
