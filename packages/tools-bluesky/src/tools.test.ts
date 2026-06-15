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

function getHandler(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const tool = createBlueskyTools({ fetcher }).find((t) => t.definition.name === 'bluesky_search');
  if (!tool || tool.kind !== 'string') throw new Error('bluesky_search tool not found');
  return tool.handler;
}

const RECENT = new Date().toISOString();
const OLD = '2020-01-01T00:00:00.000Z';

describe('BLUESKY_HUB_TOOLS', () => {
  it('exposes bluesky_search with no credential provider (public AppView)', () => {
    expect('bluesky_search' in BLUESKY_HUB_TOOLS).toBe(true);
    expect('providerName' in BLUESKY_HUB_TOOLS.bluesky_search).toBe(false);
  });
});

describe('bluesky_search', () => {
  it('queries the public AppView searchPosts endpoint with q/limit/sort', async () => {
    const captured: CapturedRequest[] = [];
    const handler = getHandler(capturingFetcher({ posts: [] }, captured));
    await handler({ query: 'solana' }, new AbortController().signal);

    const url = new URL(captured[0]!.url);
    expect(url.hostname).toBe('public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.searchPosts');
    expect(url.searchParams.get('q')).toBe('solana');
    expect(url.searchParams.get('sort')).toBe('top');
  });

  it('sends no Authorization header (unauthenticated)', async () => {
    const captured: CapturedRequest[] = [];
    const handler = getHandler(capturingFetcher({ posts: [] }, captured));
    await handler({ query: 'x' }, new AbortController().signal);
    const headers = new Headers(captured[0]!.init?.headers);
    expect(headers.has('authorization')).toBe(false);
  });

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
