import { afterEach, describe, expect, it } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import {
  ACTION_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  EDGE_REQUEST_BUDGET_MS,
  OPERATION_BUDGET_MS,
} from './connect';
import { clearSessionConnectURLs } from './browserbase';
import { createBrowserTools } from './index';
import type { BrowserConnector, BrowserFetch, BrowserLike } from './types';

function sessionFetchStub(sessionId = 'sess-1', connectUrl = 'wss://fake'): BrowserFetch {
  return (input: string, init: RequestInit) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body =
      method === 'GET' ? { id: sessionId, status: 'RUNNING' } : { id: sessionId, connectUrl };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  };
}

const hangingConnector: BrowserConnector = () => new Promise<BrowserLike>(() => {});

afterEach(() => clearSessionConnectURLs());

describe('browser tool timeout budget', () => {
  it('keeps connect below the operation budget below the edge request budget', () => {
    // The original bug: CONNECT_TIMEOUT_MS equalled the edge budget, so a hung
    // CDP connect raced the request teardown. These ordering invariants keep a
    // hung op returning a clean error before the edge can tear the request down.
    expect(OPERATION_BUDGET_MS).toBeLessThan(EDGE_REQUEST_BUDGET_MS);
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(OPERATION_BUDGET_MS);
    expect(ACTION_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_BUDGET_MS);
  });

  it('returns a clean timeout error when the CDP connect hangs', async () => {
    const runner = createToolRunner(
      createBrowserTools({
        apiKey: 'k',
        projectId: 'p',
        fetcher: sessionFetchStub(),
        connector: hangingConnector,
        operationBudgetMs: 20,
      })
    );
    const signal = new AbortController().signal;

    await runner.run({ id: 'c0', name: 'browser_create_session', arguments: {} }, signal);

    const result = await runner.run(
      {
        id: 'c1',
        name: 'browser_navigate',
        arguments: { sessionId: 'sess-1', url: 'https://example.com' },
      },
      signal
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/timed out/);
  });
});
