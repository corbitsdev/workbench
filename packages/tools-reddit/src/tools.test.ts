import { describe, expect, it } from 'bun:test';
import { REDDIT_HUB_TOOLS, createRedditTools } from './tools';

const MOCK_POST = {
  kind: 't3',
  data: {
    id: 'xyz789',
    title: 'Test Reddit Post',
    url: 'https://example.com/post',
    permalink: '/r/programming/comments/xyz789/test_reddit_post/',
    selftext: '',
    created_utc: 1700100000,
    ups: 100,
    num_comments: 10,
    subreddit: 'programming',
  },
};

const MOCK_RESPONSE = {
  data: {
    children: [MOCK_POST],
  },
};

function makeMockFetcher(response: unknown) {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('REDDIT_HUB_TOOLS', () => {
  it('exports reddit_search key', () => {
    expect('reddit_search' in REDDIT_HUB_TOOLS).toBe(true);
  });

  it('exports reddit_subreddit_search key', () => {
    expect('reddit_subreddit_search' in REDDIT_HUB_TOOLS).toBe(true);
  });

  it('reddit_search has providerName reddit', () => {
    expect(REDDIT_HUB_TOOLS.reddit_search.providerName).toBe('reddit');
  });

  it('reddit_subreddit_search has providerName reddit', () => {
    expect(REDDIT_HUB_TOOLS.reddit_subreddit_search.providerName).toBe('reddit');
  });
});

describe('createRedditTools — reddit_search happy path', () => {
  it('returns normalized items from search endpoint', async () => {
    const tools = createRedditTools({
      apiKey: 'test-token',
      baseURL: 'https://oauth.reddit.com',
      fetcher: makeMockFetcher(MOCK_RESPONSE),
    });

    const searchTool = tools.find((t) => t.definition.name === 'reddit_search');
    expect(searchTool).toBeDefined();

    const signal = new AbortController().signal;
    const raw = await (
      searchTool as {
        handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
      }
    ).handler({ query: 'typescript' }, signal);
    const items: unknown[] = JSON.parse(raw);

    expect(items).toHaveLength(1);
    const item = items[0] as Record<string, unknown>;
    expect(item.url).toBe('https://www.reddit.com/r/programming/comments/xyz789/test_reddit_post/');
    expect(item.title).toBe('Test Reddit Post');
    expect(item.source).toBe('reddit');
    const engagement = item.engagement as Record<string, unknown>;
    expect(engagement.upvotes).toBe(100);
  });
});

describe('createRedditTools — reddit_subreddit_search happy path', () => {
  it('returns normalized items from subreddit search endpoint', async () => {
    const tools = createRedditTools({
      apiKey: 'test-token',
      baseURL: 'https://oauth.reddit.com',
      fetcher: makeMockFetcher(MOCK_RESPONSE),
    });

    const subredditTool = tools.find((t) => t.definition.name === 'reddit_subreddit_search');
    expect(subredditTool).toBeDefined();

    const signal = new AbortController().signal;
    const raw = await (
      subredditTool as {
        handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
      }
    ).handler({ query: 'hooks', subreddit: 'programming' }, signal);
    const items: unknown[] = JSON.parse(raw);

    expect(items).toHaveLength(1);
    const item = items[0] as Record<string, unknown>;
    expect(item.source).toBe('reddit');
    expect(item.author).toBe('r/programming');
  });
});

describe('createRedditTools — error handling', () => {
  it('throws descriptive error on 401', async () => {
    const tools = createRedditTools({
      apiKey: 'expired-token',
      fetcher: async () => new Response(null, { status: 401 }),
    });

    const searchTool = tools.find((t) => t.definition.name === 'reddit_search');
    const signal = new AbortController().signal;

    await expect(
      (
        searchTool as {
          handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
        }
      ).handler({ query: 'test' }, signal)
    ).rejects.toThrow('Reddit access token expired — user must re-authenticate');
  });
});
