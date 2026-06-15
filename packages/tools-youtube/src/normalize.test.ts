import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { normalizeYouTubeVideo } from './normalize';
import type { YouTubeSearchItem, YouTubeVideoStatistics } from './types';

const fixtureSearchItem: YouTubeSearchItem = {
  id: { kind: 'youtube#video', videoId: 'abc123' },
  snippet: {
    publishedAt: '2024-06-01T12:00:00Z',
    title: 'How AI is changing software development',
    description: 'In this video we explore...',
    channelTitle: 'TechChannel',
  },
};

const fixtureStats: YouTubeVideoStatistics = {
  viewCount: '150000',
  likeCount: '4200',
  commentCount: '310',
};

describe('normalizeYouTubeVideo', () => {
  test('maps all fields correctly', () => {
    const item = normalizeYouTubeVideo(fixtureSearchItem, fixtureStats);
    expect(item.url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(item.title).toBe('How AI is changing software development');
    expect(item.publishedAt).toBe('2024-06-01T12:00:00Z');
    expect(item.source).toBe('youtube');
    expect(item.author).toBe('TechChannel');
    expect(item.engagement.upvotes).toBe(4200);
    expect(item.engagement.comments).toBe(310);
    expect(item.engagement.views).toBe(150000);
  });

  test('uses 0 for missing statistics', () => {
    const item = normalizeYouTubeVideo(fixtureSearchItem, undefined);
    expect(item.engagement.upvotes).toBe(0);
    expect(item.engagement.comments).toBe(0);
    expect(item.engagement.views).toBe(0);
  });

  test('uses 0 when individual stat fields are undefined', () => {
    const partialStats: YouTubeVideoStatistics = {
      viewCount: '5000',
      likeCount: undefined,
      commentCount: undefined,
    };
    const item = normalizeYouTubeVideo(fixtureSearchItem, partialStats);
    expect(item.engagement.upvotes).toBe(0);
    expect(item.engagement.comments).toBe(0);
    expect(item.engagement.views).toBe(5000);
  });

  test('constructs correct YouTube URL from videoId', () => {
    const item = normalizeYouTubeVideo(
      { ...fixtureSearchItem, id: { kind: 'youtube#video', videoId: 'xyz999' } },
      fixtureStats
    );
    expect(item.url).toBe('https://www.youtube.com/watch?v=xyz999');
  });

  test('preserves publishedAt ISO string as-is', () => {
    const customDate = '2025-01-15T08:30:00.000Z';
    const item = normalizeYouTubeVideo(
      { ...fixtureSearchItem, snippet: { ...fixtureSearchItem.snippet, publishedAt: customDate } },
      fixtureStats
    );
    expect(item.publishedAt).toBe(customDate);
  });

  test('produces a valid ResearchItem', () => {
    const item = normalizeYouTubeVideo(fixtureSearchItem, fixtureStats);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });

  test('produces a valid ResearchItem without stats', () => {
    const item = normalizeYouTubeVideo(fixtureSearchItem, undefined);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });
});
