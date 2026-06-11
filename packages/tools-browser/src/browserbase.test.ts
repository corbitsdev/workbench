import { describe, expect, it, mock } from 'bun:test';
import {
  buildConnectUrl,
  clampTimeoutSeconds,
  createSession,
  endSession,
  listRunningSessions,
  parseBrowserbaseBaseURL,
  reapStaleSessions,
  resolveConfig,
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
};

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

describe('buildConnectUrl', () => {
  it('builds a CDP url from apiKey and sessionId', () => {
    expect(buildConnectUrl('k', 's')).toBe('wss://connect.browserbase.com?apiKey=k&sessionId=s');
  });
});

describe('createSession', () => {
  it('posts projectId and timeout, returns the session id', async () => {
    const fetcher = makeFetchStub({ id: 'sess-123' });
    const sessionId = await createSession(
      { ...baseConfig, fetcher },
      600,
      new AbortController().signal
    );
    expect(sessionId).toEqual({ sessionId: 'sess-123' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.browserbase.com/v1/sessions');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'proj-1', timeout: 600 });
    expect((init.headers as Record<string, string>)['X-BB-API-Key']).toBe('bb-key');
  });

  it('throws when the response has no id', async () => {
    const fetcher = makeFetchStub({ notId: true });
    await expect(
      createSession({ ...baseConfig, fetcher }, 600, new AbortController().signal)
    ).rejects.toThrow('missing id');
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
