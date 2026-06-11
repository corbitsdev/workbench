import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { ResearchItem } from '@workbench/last30days-core';
import { normalizeHNPost } from './normalize';
import type { HNPost } from './types';

const fixture: HNPost = {
  objectID: '12345',
  title: 'Show HN: A new approach to AI',
  url: 'https://example.com/ai',
  points: 342,
  num_comments: 87,
  created_at_i: 1717200000,
};

describe('normalizeHNPost', () => {
  test('maps all fields correctly', () => {
    const item = normalizeHNPost(fixture);
    expect(item.url).toBe('https://example.com/ai');
    expect(item.title).toBe('Show HN: A new approach to AI');
    expect(item.publishedAt).toBe(new Date(1717200000 * 1000).toISOString());
    expect(item.source).toBe('hn');
    expect(item.engagement.upvotes).toBe(342);
    expect(item.engagement.comments).toBe(87);
  });

  test('falls back to HN item URL when url is undefined', () => {
    const noUrl: HNPost = { ...fixture, url: undefined };
    const item = normalizeHNPost(noUrl);
    expect(item.url).toBe('https://news.ycombinator.com/item?id=12345');
  });

  test('uses 0 for missing points', () => {
    const noPoints: HNPost = { ...fixture, points: undefined };
    const item = normalizeHNPost(noPoints);
    expect(item.engagement.upvotes).toBe(0);
  });

  test('uses 0 for missing num_comments', () => {
    const noComments: HNPost = { ...fixture, num_comments: undefined };
    const item = normalizeHNPost(noComments);
    expect(item.engagement.comments).toBe(0);
  });

  test('omits entityTag', () => {
    const item = normalizeHNPost(fixture);
    expect('entityTag' in item).toBe(false);
  });

  test('produces a valid ResearchItem', () => {
    const item = normalizeHNPost(fixture);
    const result = ResearchItem(item);
    expect(result instanceof type.errors).toBe(false);
  });
});
