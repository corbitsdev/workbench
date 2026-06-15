import { describe, expect, it } from 'bun:test';
import { BLUESKY_HUB_TOOLS, createBlueskyTools } from './tools';

type CapturedRequest = { url: string; init: RequestInit | undefined };

function makePost(overrides: { text: string; createdAt: string; indexedAt: string }) {
  return {
    uri: 'at://did:plc:abc/app.bsky.feed.post/xyz',
    author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
    record: { text: overrides.text, createdAt: overrides.createdAt },
    likeCount: 42,
    replyCount: 7,
    repostCount: 3,
    indexedAt: overrides.indexedAt,
  };
}

function capturingFetcher(response: unknown, captured: CapturedRequest[], status = 200) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    captured.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function getHandler(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  handle?: string,
  appPassword?: string
) {
  const tool = createBlueskyTools({ fetcher, handle, appPassword }).find(
    (t) => t.definition.name === 'bluesky_search'
  );
  if (!tool || tool.kind !== 'string') throw new Error('bluesky_search tool not found');
  return tool.handler;
}

const RECENT = new Date().toISOString();
const OLD = '2020-01-01T00:00:00.000Z';

describe('BLUESKY_HUB_TOOLS', () => {
  it('exposes bluesky_search as a credential tool with providerName bluesky', () => {
    expect('bluesky_search' in BLUESKY_HUB_TOOLS).toBe(true);
    expect(
      (BLUESKY_HUB_TOOLS.bluesky_search as { providerName: string }).providerName
    ).toBe('bluesky');
  });
});

describe('bluesky_search User-Agent', () => {
  it('sends a gtm-workbench-bluesky User-Agent on every request', async () => {
    const captured: CapturedRequest[] = [];
    const handler = getHandler(capturingFetcher({ posts: [] }, captured));
    await handler({ query: 'solana' }, new AbortController().signal);

    const headers = new Headers(captured[0]!.init?.headers);
    expect(headers.get('user-agent')).toContain('gtm-workbench-bluesky');
  });
});

describe('bluesky_search unauthenticated path', () => {
  it('queries the public AppView when no credentials are provided', async () => {
    const captured: CapturedRequest[] = [];
    const handler = getHandler(capturingFetcher({ posts: [] }, captured));
    await handler({ query: 'solana' }, new AbortController().signal);

    const url = new URL(captured[0]!.url);
    expect(url.hostname).toBe('public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.searchPosts');
    expect(url.searchParams.get('q')).toBe('solana');
    expect(url.searchParams.get('sort')).toBe('top');
  });

  it('sends no Authorization header when no credentials are provided', async () => {
    const captured: CapturedRequest[] = [];
    const handler = getHandler(capturingFetcher({ posts: [] }, captured));
    await handler({ query: 'x' }, new AbortController().signal);
    const headers = new Headers(captured[0]!.init?.headers);
    expect(headers.has('authorization')).toBe(false);
  });
});

describe('bluesky_search authenticated path', () => {
  it('creates an AT Protocol session then sends Bearer token on searchPosts', async () => {
    const captured: CapturedRequest[] = [];

    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({ url, init });
      if (url.includes('createSession')) {
        return new Response(JSON.stringify({ accessJwt: 'tok123', did: 'did:plc:test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = getHandler(fetcher, 'alice.bsky.social', 'xxxx-yyyy-zzzz');
    await handler({ query: 'test' }, new AbortController().signal);

    const createSessionCall = captured.find((r) => r.url.includes('createSession'));
    expect(createSessionCall).toBeDefined();

    const searchCall = captured.find((r) => r.url.includes('searchPosts'));
    expect(searchCall).toBeDefined();
    const searchHeaders = new Headers(searchCall!.init?.headers);
    expect(searchHeaders.get('authorization')).toBe('Bearer tok123');
  });

  it('retries searchPosts exactly once after a 401 by creating a fresh session', async () => {
    const captured: CapturedRequest[] = [];
    let searchCallCount = 0;

    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({ url, init });
      if (url.includes('createSession')) {
        return new Response(JSON.stringify({ accessJwt: 'fresh-tok', did: 'did:plc:test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      searchCallCount++;
      if (searchCallCount === 1) {
        return new Response(JSON.stringify({ error: 'ExpiredToken' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = getHandler(fetcher, 'alice.bsky.social', 'xxxx-yyyy-zzzz');
    await handler({ query: 'test' }, new AbortController().signal);

    expect(searchCallCount).toBe(2);
    const sessionCalls = captured.filter((r) => r.url.includes('createSession'));
    expect(sessionCalls).toHaveLength(2);
  });
});

describe('bluesky_search behavior', () => {
  it('requires a query', async () => {
    const handler = getHandler(capturingFetcher({ posts: [] }, []));
    await expect(handler({}, new AbortController().signal)).rejects.toThrow('query is required');
  });

  it('maps engagement fields and keeps posts within the day window', async () => {
    const handler = getHandler(
      capturingFetcher(
        { posts: [makePost({ text: 'recent post', createdAt: RECENT, indexedAt: RECENT })] },
        []
      )
    );
    const items = JSON.parse(await handler({ query: 'x' }, new AbortController().signal));
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('bluesky');
    expect(items[0].engagement.upvotes).toBe(42);
    expect(items[0].engagement.comments).toBe(7);
    expect(items[0].engagement.shares).toBe(3);
  });

  it('drops posts older than the window', async () => {
    const handler = getHandler(
      capturingFetcher(
        {
          posts: [
            makePost({ text: 'recent', createdAt: RECENT, indexedAt: RECENT }),
            makePost({ text: 'ancient', createdAt: OLD, indexedAt: OLD }),
          ],
        },
        []
      )
    );
    const items = JSON.parse(await handler({ query: 'x', days: 30 }, new AbortController().signal));
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('recent');
  });

  it('returns an empty array when nothing falls in the window', async () => {
    const handler = getHandler(
      capturingFetcher({ posts: [makePost({ text: 'old', createdAt: OLD, indexedAt: OLD })] }, [])
    );
    const items = JSON.parse(await handler({ query: 'x' }, new AbortController().signal));
    expect(items).toEqual([]);
  });

  it('surfaces the response body on a non-OK status', async () => {
    const handler = getHandler(capturingFetcher({ error: 'RateLimitExceeded' }, [], 429));
    await expect(handler({ query: 'x' }, new AbortController().signal)).rejects.toThrow(
      /Bluesky API error: 429/
    );
  });
});
