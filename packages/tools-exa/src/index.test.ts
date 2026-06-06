import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createExaTools, type ExaFetch } from './index';

type FetchStub = ExaFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

describe('createExaTools', () => {
  it('returns one tool', () => {
    const tools = createExaTools({ apiKey: 'test-key' });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe('exa_search');
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
    const runner = createToolRunner(createExaTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'exa_search', arguments: { query: 'test query' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual(stubResponse);
  });

  it('respects numResults cap', async () => {
    const fetcher = makeFetchStub({ results: [] });
    const runner = createToolRunner(createExaTools({ apiKey: 'test-key', fetcher }));

    await runner.run(
      { id: 'call_1', name: 'exa_search', arguments: { query: 'test', numResults: 100 } },
      new AbortController().signal
    );

    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1].body));
    expect(body.numResults).toBe(25);
  });

  it('surfaces API errors', async () => {
    const fetcher = makeFetchStub({ message: 'Invalid API key' }, 401);
    const runner = createToolRunner(createExaTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'exa_search', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Exa API error: 401 Invalid API key');
  });
});
