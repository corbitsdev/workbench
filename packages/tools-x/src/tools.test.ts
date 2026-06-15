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

  const responsesApiResponse = {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ items: apiResults }),
          },
        ],
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

  function makeCapturingFetcher(response: unknown, calls: { url: string; init: RequestInit }[]) {
    return async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
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
    const tools = createXTools({
      apiKey: 'test-key',
      fetcher: makeFetcher(mockResponse),
    });
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

  it('uses the xAI Responses x_search endpoint and forwards date range parameters', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tools = createXTools({
      apiKey: 'test-key',
      fetcher: makeCapturingFetcher(responsesApiResponse, calls),
    });
    const xSearch = findStringTool(tools, 'x_search');

    await xSearch.handler(
      { query: 'AI funding', fromDate: '2026-05-15', toDate: '2026-06-14' },
      new AbortController().signal
    );

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      tools: [{ type: 'x_search', from_date: '2026-05-15', to_date: '2026-06-14' }],
    });
    expect(body).not.toHaveProperty('search_parameters');
  });

  it('ignores an empty hub baseURL and uses the xAI default endpoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tools = createXTools({
      apiKey: 'test-key',
      baseURL: '',
      fetcher: makeCapturingFetcher(responsesApiResponse, calls),
    });
    const xSearch = findStringTool(tools, 'x_search');

    await xSearch.handler({ query: 'AI funding' }, new AbortController().signal);

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
  });

  it('accepts a hub baseURL that already includes /v1', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tools = createXTools({
      apiKey: 'test-key',
      baseURL: 'https://api.x.ai/v1',
      fetcher: makeCapturingFetcher(responsesApiResponse, calls),
    });
    const xSearch = findStringTool(tools, 'x_search');

    await xSearch.handler({ query: 'AI funding' }, new AbortController().signal);

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
  });

  it('throws when query is missing', async () => {
    const tools = createXTools({
      apiKey: 'test-key',
      fetcher: makeFetcher(mockResponse),
    });
    const xSearch = findStringTool(tools, 'x_search');
    expect(xSearch.handler({}, new AbortController().signal)).rejects.toThrow('query is required');
  });

  it('throws on non-ok response and includes the response body', async () => {
    const errorFetcher = async (): Promise<Response> =>
      ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({}),
        text: async () => '{"error":"rate limit exceeded"}',
      }) as unknown as Response;

    const tools = createXTools({ apiKey: 'test-key', fetcher: errorFetcher });
    const xSearch = findStringTool(tools, 'x_search');
    const error = await xSearch
      .handler({ query: 'test' }, new AbortController().signal)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('xAI API error: 429');
    expect((error as Error).message).toContain('rate limit exceeded');
  });
});
