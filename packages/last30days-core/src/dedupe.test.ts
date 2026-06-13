import { describe, expect, test } from 'bun:test';
import { dedupe } from './dedupe';
import type { ResearchItem } from './schema';

function makeItem(overrides: Partial<ResearchItem> & { url: string; title: string }): ResearchItem {
  return {
    publishedAt: '2026-06-01T12:00:00Z',
    source: 'hn',
    engagement: { upvotes: 10, comments: 5 },
    ...overrides,
  };
}

describe('dedupe', () => {
  test('distinct items are all preserved', () => {
    const items = [
      makeItem({ url: 'https://example.com/a', title: 'Post A' }),
      makeItem({ url: 'https://example.com/b', title: 'Post B' }),
      makeItem({ url: 'https://example.com/c', title: 'Post C' }),
    ];
    expect(dedupe(items)).toHaveLength(3);
  });

  test('same URL across two sources collapses to one item', () => {
    const items = [
      makeItem({
        url: 'https://example.com/story',
        title: 'Story',
        source: 'hn',
        engagement: { upvotes: 100, comments: 10 },
      }),
      makeItem({
        url: 'https://example.com/story',
        title: 'Story',
        source: 'reddit',
        engagement: { upvotes: 50, comments: 5 },
      }),
    ];
    expect(dedupe(items)).toHaveLength(1);
  });

  test('cross-source URL dedup keeps the item with higher engagement', () => {
    const highEngagement = makeItem({
      url: 'https://example.com/story',
      title: 'Story',
      source: 'hn',
      engagement: { upvotes: 100, comments: 10 },
    });
    const lowEngagement = makeItem({
      url: 'https://example.com/story',
      title: 'Story',
      source: 'reddit',
      engagement: { upvotes: 20, comments: 2 },
    });
    const result = dedupe([lowEngagement, highEngagement]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('hn');
  });

  test('same source duplicate URL keeps first-seen item', () => {
    const first = makeItem({
      url: 'https://example.com/story',
      title: 'Story',
      source: 'hn',
      engagement: { upvotes: 10, comments: 1 },
    });
    const second = makeItem({
      url: 'https://example.com/story',
      title: 'Story different title',
      source: 'hn',
      engagement: { upvotes: 10, comments: 1 },
    });
    const result = dedupe([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Story');
  });

  test('same normalized title collapses to one item', () => {
    const items = [
      makeItem({ url: 'https://hn.com/1', title: 'Show HN: My Cool Project!' }),
      makeItem({ url: 'https://reddit.com/1', title: 'show hn my cool project', source: 'reddit' }),
    ];
    expect(dedupe(items)).toHaveLength(1);
  });

  test('similar but distinct titles are kept separate', () => {
    const items = [
      makeItem({ url: 'https://hn.com/1', title: 'How to build a web server' }),
      makeItem({ url: 'https://hn.com/2', title: 'How to build a mobile app' }),
    ];
    expect(dedupe(items)).toHaveLength(2);
  });

  test('empty array returns empty array', () => {
    expect(dedupe([])).toEqual([]);
  });

  test('single item returns itself unchanged', () => {
    const item = makeItem({ url: 'https://example.com', title: 'Solo' });
    const result = dedupe([item]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(item);
  });
});
