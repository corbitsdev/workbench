import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createScrapeCreatorsTools, SCRAPECREATORS_HUB_TOOLS } from './tools';

describe('SCRAPECREATORS_HUB_TOOLS', () => {
  it('exports all four tools with providerName scrapecreators', () => {
    const keys = Object.keys(SCRAPECREATORS_HUB_TOOLS) as (keyof typeof SCRAPECREATORS_HUB_TOOLS)[];
    expect(keys).toEqual([
      'scrapecreators_tiktok',
      'scrapecreators_instagram',
      'scrapecreators_threads',
      'scrapecreators_pinterest',
    ]);

    for (const key of keys) {
      expect(SCRAPECREATORS_HUB_TOOLS[key].providerName).toBe('scrapecreators');
    }
  });

  it('each entry definition name matches its key', () => {
    for (const [key, entry] of Object.entries(SCRAPECREATORS_HUB_TOOLS)) {
      expect(entry.definition.name).toBe(key);
    }
  });

  it('createTools returns all four tools', () => {
    const tools = SCRAPECREATORS_HUB_TOOLS.scrapecreators_tiktok.createTools({
      apiKey: 'test-key',
    });
    expect(tools.map((t) => t.definition.name)).toEqual([
      'scrapecreators_tiktok',
      'scrapecreators_instagram',
      'scrapecreators_threads',
      'scrapecreators_pinterest',
    ]);
  });
});

describe('scrapecreators_tiktok happy path', () => {
  it('fetches TikTok posts and returns normalized items', async () => {
    const fetcher = mock(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/tiktok/search/posts');
      expect(url.searchParams.get('query')).toBe('product launch');
      expect((init?.headers as Record<string, string>)?.['x-api-key']).toBe('test-api-key');

      return new Response(
        JSON.stringify({
          posts: [
            {
              id: 'vid_001',
              webVideoUrl: 'https://www.tiktok.com/@creator/video/vid_001',
              desc: 'Exciting product launch video',
              createTime: 1700000000,
              diggCount: 1500,
              authorMeta: { name: 'creator_handle' },
            },
          ],
        }),
        { status: 200 }
      );
    });

    const runner = createToolRunner(createScrapeCreatorsTools({ apiKey: 'test-api-key', fetcher }));

    const result = await runner.run(
      {
        id: 'call_tiktok',
        name: 'scrapecreators_tiktok',
        arguments: { query: 'product launch' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();

    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(1);

    const item = items[0] as Record<string, unknown>;
    expect(item['url']).toBe('https://www.tiktok.com/@creator/video/vid_001');
    expect(item['title']).toBe('Exciting product launch video');
    expect(item['author']).toBe('creator_handle');
    expect(item['source']).toBe('tiktok');
    expect((item['engagement'] as Record<string, unknown>)['upvotes']).toBe(1500);
    expect(item['publishedAt']).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('surfaces API errors as tool errors', async () => {
    const fetcher = mock(async () => new Response('', { status: 403, statusText: 'Forbidden' }));

    const runner = createToolRunner(createScrapeCreatorsTools({ apiKey: 'bad-key', fetcher }));

    const result = await runner.run(
      { id: 'call_err', name: 'scrapecreators_tiktok', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('403');
  });

  it('throws when query is missing', async () => {
    const fetcher = mock(async () => new Response('{}', { status: 200 }));

    const runner = createToolRunner(createScrapeCreatorsTools({ apiKey: 'k', fetcher }));

    const result = await runner.run(
      { id: 'call_no_query', name: 'scrapecreators_tiktok', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('query is required');
  });
});
