import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createBrowserTools, BROWSER_DEFINITIONS } from './browser';
import type { FirecrawlFetch } from './shared';

type FetchStub = FirecrawlFetch & {
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

describe('createBrowserTools', () => {
  it('returns the browser tools', () => {
    const tools = createBrowserTools({ apiKey: 'test-key' });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      BROWSER_DEFINITIONS.map((definition) => definition.name)
    );
  });
});

describe('firecrawl_interact handler', () => {
  it('posts to /scrape/{jobId}/interact', async () => {
    const fetcher = makeFetchStub({ success: true, stdout: 'clicked' });
    const runner = createToolRunner(createBrowserTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'firecrawl_interact',
        arguments: { jobId: 'job_1', prompt: 'Click the submit button', timeout: 30 },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.firecrawl.dev/v2/scrape/job_1/interact');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      prompt: 'Click the submit button',
      timeout: 30,
    });
  });
});

describe('firecrawl_browser_sessions_list handler', () => {
  it('gets /browser/sessions', async () => {
    const fetcher = makeFetchStub({ success: true, sessions: [] });
    const runner = createToolRunner(createBrowserTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'firecrawl_browser_sessions_list', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.firecrawl.dev/v2/browser/sessions');
    expect(call?.[1].method).toBe('GET');
  });
});

describe('firecrawl_browser_session_delete handler', () => {
  it('deletes /browser/sessions/{id}', async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(createBrowserTools({ apiKey: 'test-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'firecrawl_browser_session_delete', arguments: { id: 'sess_1' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe('https://api.firecrawl.dev/v2/browser/sessions/sess_1');
    expect(call?.[1].method).toBe('DELETE');
  });
});
