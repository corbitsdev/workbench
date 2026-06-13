import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  clearSessionConnectURLs,
  clampTimeoutSeconds,
  createSession,
  endSession,
  listRunningSessions,
  lookupSessionConnectURL,
  parseBrowserbaseBaseURL,
  reapStaleSessions,
  removeSessionConnectURL,
  resolveConfig,
  storeSessionConnectURL,
  waitForSessionRunning,
} from './browserbase';
import type { BrowserFetch, ResolvedBrowserConfig } from './types';

function makeFetchStub(
  response: unknown,
  status = 200
): BrowserFetch & { mock: { calls: [string, RequestInit][] } } {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

const baseConfig: ResolvedBrowserConfig = {
  apiKey: 'bb-key',
  baseUrl: 'https://api.browserbase.com/v1',
  projectId: 'proj-1',
  fetcher: makeFetchStub({}),
  connector: () => Promise.reject(new Error('unused')),
  operationBudgetMs: 18_000,
};

beforeEach(() => {
  clearSessionConnectURLs();
});

describe('parseBrowserbaseBaseURL', () => {
  it('splits projectId off the query string', () => {
    expect(parseBrowserbaseBaseURL('https://api.browserbase.com/v1?projectId=abc')).toEqual({
      baseUrl: 'https://api.browserbase.com/v1',
      projectId: 'abc',
    });
  });

  it('returns the default base and no projectId when empty', () => {
    expect(parseBrowserbaseBaseURL('')).toEqual({
      baseUrl: 'https://api.browserbase.com/v1',
      projectId: undefined,
    });
  });

  it('throws on an invalid URL', () => {
    expect(() => parseBrowserbaseBaseURL('not a url')).toThrow('valid URL');
  });
});

describe('resolveConfig', () => {
  it('requires an apiKey', () => {
    expect(() => resolveConfig({ apiKey: '', projectId: 'p' })).toThrow('apiKey is required');
  });

  it('fails loud when projectId is missing', () => {
    expect(() => resolveConfig({ apiKey: 'k' })).toThrow('projectId is required');
  });

  it('resolves a valid config', () => {
    const resolved = resolveConfig({ apiKey: 'k', projectId: 'p' });
    expect(resolved.baseUrl).toBe('https://api.browserbase.com/v1');
    expect(resolved.projectId).toBe('p');
  });
});

describe('clampTimeoutSeconds', () => {
  it('defaults when not a number', () => {
    expect(clampTimeoutSeconds(undefined)).toBe(600);
  });
  it('clamps below the floor', () => {
    expect(clampTimeoutSeconds(5)).toBe(60);
  });
  it('clamps above the ceiling', () => {
    expect(clampTimeoutSeconds(99999)).toBe(3600);
  });
});

describe('session connect URL store', () => {
  it('stores and retrieves a connectUrl by sessionId', () => {
    storeSessionConnectURL('s1', 'wss://url-1');
    expect(lookupSessionConnectURL('s1')).toBe('wss://url-1');
  });

  it('throws when the sessionId is not in the store', () => {
    expect(() => lookupSessionConnectURL('missing')).toThrow('missing');
  });

  it('remove deletes the entry so a subsequent lookup throws', () => {
    storeSessionConnectURL('s2', 'wss://url-2');
    removeSessionConnectURL('s2');
    expect(() => lookupSessionConnectURL('s2')).toThrow('s2');
  });

  it('remove on a missing key is a no-op', () => {
    expect(() => removeSessionConnectURL('never-stored')).not.toThrow();
  });
});

describe('createSession', () => {
  it('sends keepAlive:true, posts projectId and timeout, returns sessionId and connectUrl', async () => {
    const fetcher = makeFetchStub({
      id: 'sess-123',
      connectUrl: 'wss://connect.browserbase.com/playwright?apiKey=bb-key&sessionId=sess-123',
    });
    const result = await createSession(
      { ...baseConfig, fetcher },
      600,
      new AbortController().signal
    );
    expect(result).toEqual({
      sessionId: 'sess-123',
      connectUrl: 'wss://connect.browserbase.com/playwright?apiKey=bb-key&sessionId=sess-123',
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.browserbase.com/v1/sessions');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'proj-1',
      timeout: 600,
      keepAlive: true,
    });
    expect((init.headers as Record<string, string>)['X-BB-API-Key']).toBe('bb-key');
  });

  it('throws when the response has no id', async () => {
    const fetcher = makeFetchStub({ notId: true, connectUrl: 'wss://x' });
    await expect(
      createSession({ ...baseConfig, fetcher }, 600, new AbortController().signal)
    ).rejects.toThrow('missing id');
  });

  it('throws when the response has no connectUrl', async () => {
    const fetcher = makeFetchStub({ id: 'sess-123' });
    await expect(
      createSession({ ...baseConfig, fetcher }, 600, new AbortController().signal)
    ).rejects.toThrow('missing connectUrl');
  });

  it('surfaces API errors', async () => {
    const fetcher = makeFetchStub({ message: 'bad key' }, 401);
    await expect(
      createSession({ ...baseConfig, fetcher }, 600, new AbortController().signal)
    ).rejects.toThrow('Browserbase API error: 401 bad key');
  });
});

describe('endSession', () => {
  it('posts a release request', async () => {
    const fetcher = makeFetchStub({ status: 'RELEASED' });
    await endSession({ ...baseConfig, fetcher }, 'sess-9', new AbortController().signal);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.browserbase.com/v1/sessions/sess-9');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'proj-1',
      status: 'REQUEST_RELEASE',
    });
  });

  it('surfaces API errors', async () => {
    const fetcher = makeFetchStub({}, 500);
    await expect(
      endSession({ ...baseConfig, fetcher }, 's', new AbortController().signal)
    ).rejects.toThrow('Browserbase API error: 500');
  });
});

type RoutedFetch = BrowserFetch & { posts: string[] };

/** GET /sessions returns the given list; POST /sessions/:id records a release. */
function routedFetch(sessions: unknown[]): RoutedFetch {
  const posts: string[] = [];
  const fetcher = ((input: string, init: RequestInit) => {
    if ((init.method ?? 'GET') === 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify(sessions), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    posts.push(input);
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'RELEASED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as RoutedFetch;
  fetcher.posts = posts;
  return fetcher;
}

describe('listRunningSessions', () => {
  it('requests RUNNING sessions and parses the list', async () => {
    const fetcher = routedFetch([
      { id: 'a', status: 'RUNNING', startedAt: '2026-01-01T00:00:00Z' },
      { notASession: true },
    ]);
    const sessions = await listRunningSessions(
      { ...baseConfig, fetcher },
      new AbortController().signal
    );
    expect(sessions).toEqual([{ id: 'a', status: 'RUNNING', startedAt: '2026-01-01T00:00:00Z' }]);
  });

  it('throws when the response is not an array', async () => {
    const fetcher = makeFetchStub({ not: 'an array' });
    await expect(
      listRunningSessions({ ...baseConfig, fetcher }, new AbortController().signal)
    ).rejects.toThrow('not an array');
  });
});

describe('reapStaleSessions', () => {
  const now = Date.parse('2026-01-01T01:00:00Z');

  it('releases sessions older than maxAge and leaves fresh ones', async () => {
    const fetcher = routedFetch([
      { id: 'old', status: 'RUNNING', startedAt: '2026-01-01T00:00:00Z' }, // 60 min old
      { id: 'fresh', status: 'RUNNING', startedAt: '2026-01-01T00:59:00Z' }, // 1 min old
    ]);
    const result = await reapStaleSessions(
      { ...baseConfig, fetcher },
      30 * 60 * 1000,
      now,
      new AbortController().signal
    );
    expect(result.reaped).toEqual(['old']);
    expect(fetcher.posts).toEqual(['https://api.browserbase.com/v1/sessions/old']);
  });

  it('skips sessions with no parseable age rather than guessing', async () => {
    const fetcher = routedFetch([{ id: 'mystery', status: 'RUNNING' }]);
    const result = await reapStaleSessions(
      { ...baseConfig, fetcher },
      1000,
      now,
      new AbortController().signal
    );
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual(['mystery']);
    expect(fetcher.posts).toEqual([]);
  });
});

describe('waitForSessionRunning', () => {
  it('resolves immediately when the session is already RUNNING', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1', status: 'RUNNING' });
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      })
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.browserbase.com/v1/sessions/sess-1');
    expect((init.method as string).toUpperCase()).toBe('GET');
    expect((init.headers as Record<string, string>)['X-BB-API-Key']).toBe('bb-key');
  });

  it('polls until RUNNING then resolves', async () => {
    let callCount = 0;
    const fetcher = mock((_input: string, _init: RequestInit) => {
      callCount++;
      const status = callCount < 3 ? 'PENDING' : 'RUNNING';
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'sess-1', status }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as BrowserFetch & { mock: { calls: [string, RequestInit][] } };
    await waitForSessionRunning(
      { ...baseConfig, fetcher },
      'sess-1',
      new AbortController().signal,
      {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      }
    );
    expect(fetcher.mock.calls).toHaveLength(3);
  });

  it('throws immediately when status is ERROR', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1', status: 'ERROR' });
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      })
    ).rejects.toThrow('ERROR');
  });

  it('throws immediately when status is TIMED_OUT', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1', status: 'TIMED_OUT' });
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      })
    ).rejects.toThrow('TIMED_OUT');
  });

  it('throws immediately when status is COMPLETED', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1', status: 'COMPLETED' });
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      })
    ).rejects.toThrow('COMPLETED');
  });

  it('throws after the deadline is exceeded', async () => {
    const fetcher = makeFetchStub({ id: 'sess-1', status: 'PENDING' });
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 0,
      })
    ).rejects.toThrow('did not reach RUNNING');
  });

  it('surfaces API errors from the status poll', async () => {
    const fetcher = makeFetchStub({ message: 'not found' }, 404);
    await expect(
      waitForSessionRunning({ ...baseConfig, fetcher }, 'sess-1', new AbortController().signal, {
        pollIntervalMs: 0,
        maxWaitMs: 5_000,
      })
    ).rejects.toThrow('Browserbase API error: 404');
  });
});
