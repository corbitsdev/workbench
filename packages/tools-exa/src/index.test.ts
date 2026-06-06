import { describe, expect, it, mock } from 'bun:test';
import { createExaTools } from './index';

function makeFetchStub(response: unknown, status = 200): typeof fetch {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  ) as unknown as typeof fetch;
}

describe('createExaTools', () => {
  it('returns one tool', () => {
    const tools = createExaTools({ apiKey: 'test-key' });
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.name).toBe('exa_search');
  });

  it('throws when apiKey is empty', () => {
    expect(() => createExaTools({ apiKey: '' })).toThrow('Exa apiKey is required');
  });

  it('throws when baseUrl is invalid', () => {
    expect(() => createExaTools({ apiKey: 'test-key', baseUrl: 'not-a-url' })).toThrow(
      'Exa baseUrl must be a valid URL'
    );
  });
});

describe('exa_search handler', () => {
  it('searches with default parameters', async () => {
    const stubResponse = {
      results: [
        {
          title: 'Test Result',
          url: 'https://example.com',
          publishedDate: '2024-01-01T00:00:00.000Z',
          author: 'Test Author',
          text: 'Test text',
          summary: 'Test summary',
        },
      ],
    };

    const fetcher = makeFetchStub(stubResponse);
    const tools = createExaTools({ apiKey: 'test-key', fetcher });
    const handler = tools[0].handler;

    const result = await handler({ query: 'test query' }, new AbortController().signal);
    expect(JSON.parse(result)).toEqual(stubResponse);
  });

  it('respects numResults cap', async () => {
    const fetcher = makeFetchStub({ results: [] });
    const tools = createExaTools({ apiKey: 'test-key', fetcher });
    const handler = tools[0].handler;

    await handler({ query: 'test', numResults: 100 }, new AbortController().signal);

    const call = fetcher.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.numResults).toBe(25);
  });

  it('surfaces API errors', async () => {
    const fetcher = makeFetchStub({ message: 'Invalid API key' }, 401);
    const tools = createExaTools({ apiKey: 'test-key', fetcher });
    const handler = tools[0].handler;

    await expect(handler({ query: 'test' }, new AbortController().signal)).rejects.toThrow(
      'Exa API error: 401 Invalid API key'
    );
  });
});
