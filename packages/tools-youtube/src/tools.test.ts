import { describe, expect, mock, test } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { createYouTubeTools, YOUTUBE_HUB_TOOLS, type YouTubeFetch } from './tools';

const FAKE_API_KEY = 'test-api-key';

function makeSearchResponse(videoIds: string[]) {
  return {
    items: videoIds.map((videoId, i) => ({
      id: { kind: 'youtube#video', videoId },
      snippet: {
        publishedAt: '2024-06-01T12:00:00Z',
        title: `Video ${i + 1}`,
        description: 'Test description',
        channelTitle: `Channel ${i + 1}`,
      },
    })),
  };
}

function makeVideosResponse(videoIds: string[]) {
  return {
    items: videoIds.map((id, i) => ({
      id,
      statistics: {
        viewCount: String((i + 1) * 10000),
        likeCount: String((i + 1) * 500),
        commentCount: String((i + 1) * 50),
      },
    })),
  };
}

function makeFetchStub(responses: unknown[]): YouTubeFetch {
  let callIndex = 0;
  return mock((_url: string, _init?: RequestInit) => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
}

function makeErrorFetch(status: number, statusText: string, body = 'Error'): YouTubeFetch {
  return mock((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status, statusText }))
  );
}

describe('youtube_search tool', () => {
  test('returns normalized ResearchItems on success', async () => {
    const videoIds = ['abc123', 'def456'];
    const fetcher = makeFetchStub([makeSearchResponse(videoIds), makeVideosResponse(videoIds)]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'AI tools' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items: unknown = JSON.parse(String(result.content));
    expect(Array.isArray(items)).toBe(true);
    const arr = items as unknown[];
    expect(arr).toHaveLength(2);

    for (const item of arr) {
      const validation = ResearchItem(item);
      expect(validation instanceof type.errors).toBe(false);
    }

    const first = arr[0] as Record<string, unknown>;
    expect(first.source).toBe('youtube');
    expect(first.url).toBe('https://www.youtube.com/watch?v=abc123');
  });

  test('maps engagement fields correctly from statistics', async () => {
    const videoIds = ['vid1'];
    const fetcher = makeFetchStub([makeSearchResponse(videoIds), makeVideosResponse(videoIds)]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    const item = items[0] as Record<string, unknown>;
    const engagement = item.engagement as Record<string, number>;

    expect(engagement.views).toBe(10000);
    expect(engagement.upvotes).toBe(500);
    expect(engagement.comments).toBe(50);
  });

  test('includes author from channelTitle', async () => {
    const videoIds = ['vid1'];
    const fetcher = makeFetchStub([makeSearchResponse(videoIds), makeVideosResponse(videoIds)]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    const item = items[0] as Record<string, unknown>;
    expect(item.author).toBe('Channel 1');
  });

  test('returns empty array when search returns no items', async () => {
    const fetcher = makeFetchStub([{ items: [] }]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'obscure topic xyz' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    expect(items).toHaveLength(0);
  });

  test('uses 0 for engagement when statistics are unavailable', async () => {
    const videoIds = ['vid1'];
    const searchResp = makeSearchResponse(videoIds);
    const videosResp = { items: [] };
    const fetcher = makeFetchStub([searchResp, videosResp]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'test' } },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    const items = JSON.parse(String(result.content)) as unknown[];
    const item = items[0] as Record<string, unknown>;
    const engagement = item.engagement as Record<string, number>;
    expect(engagement.upvotes).toBe(0);
    expect(engagement.comments).toBe(0);
    expect(engagement.views).toBe(0);
  });

  test('surfaces search API HTTP error as tool error', async () => {
    const fetcher = makeErrorFetch(403, 'Forbidden', '{"error":"quota exceeded"}');
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'AI' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('403');
  });

  test('surfaces videos API HTTP error as tool error', async () => {
    const videoIds = ['vid1'];
    let callCount = 0;
    const fetcher: YouTubeFetch = mock((_url: string, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(makeSearchResponse(videoIds)), {
            status: 200,
            statusText: 'OK',
          })
        );
      }
      return Promise.resolve(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
      );
    });
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: { query: 'AI' } },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('503');
  });

  test('surfaces missing query as tool error', async () => {
    const fetcher = makeFetchStub([{ items: [] }]);
    const runner = createToolRunner(createYouTubeTools({ apiKey: FAKE_API_KEY, fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'youtube_search', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('query is required');
  });

  test('YOUTUBE_HUB_TOOLS has correct structure', () => {
    expect(YOUTUBE_HUB_TOOLS.youtube_search.definition.name).toBe('youtube_search');
    expect(YOUTUBE_HUB_TOOLS.youtube_search.providerName).toBe('youtube');
    expect(typeof YOUTUBE_HUB_TOOLS.youtube_search.createTools).toBe('function');
  });
});
