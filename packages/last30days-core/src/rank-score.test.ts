import { describe, expect, test } from 'bun:test';
import { rankScore } from './rank-score';
import type { Cluster } from './cluster-merge';
import type { ResearchItem } from './schema';

const NOW_ISO = '2026-06-11T12:00:00Z';

function makeItem(overrides: Partial<ResearchItem> & { url: string; title: string }): ResearchItem {
  return {
    publishedAt: '2026-06-10T12:00:00Z',
    source: 'hn',
    engagement: { upvotes: 100, comments: 10 },
    ...overrides,
  };
}

function makeCluster(items: ResearchItem[], id = 'c1'): Cluster {
  const first = items[0];
  if (!first) throw new Error('cluster must have at least one item');
  return {
    id,
    items,
    sources: new Set(items.map((i) => i.source)),
    topItem: first,
  };
}

describe('rankScore', () => {
  test('returns clusters in descending score order', () => {
    const highEngagement = makeCluster(
      [
        makeItem({
          url: 'https://a.com',
          title: 'High',
          engagement: { upvotes: 1000, comments: 200 },
        }),
      ],
      'high'
    );
    const lowEngagement = makeCluster(
      [makeItem({ url: 'https://b.com', title: 'Low', engagement: { upvotes: 10, comments: 1 } })],
      'low'
    );
    const result = rankScore([lowEngagement, highEngagement], { topic: 'test', nowIso: NOW_ISO });
    expect(result[0]?.id).toBe('high');
    expect(result[1]?.id).toBe('low');
  });

  test('multi-source cluster outranks single-source cluster with equal raw engagement', () => {
    const singleSource = makeCluster(
      [
        makeItem({
          url: 'https://a.com',
          title: 'Single',
          engagement: { upvotes: 100, comments: 10 },
          source: 'hn',
        }),
      ],
      'single'
    );
    const multiSource = makeCluster(
      [
        makeItem({
          url: 'https://b.com',
          title: 'Multi HN',
          engagement: { upvotes: 50, comments: 5 },
          source: 'hn',
        }),
        makeItem({
          url: 'https://c.com',
          title: 'Multi Reddit',
          engagement: { upvotes: 50, comments: 5 },
          source: 'reddit',
        }),
      ],
      'multi'
    );
    const result = rankScore([singleSource, multiSource], { topic: 'test', nowIso: NOW_ISO });
    expect(result[0]?.id).toBe('multi');
  });

  test('degraded provenance cluster scores lower than equivalent clean cluster', () => {
    const clean = makeCluster(
      [
        makeItem({
          url: 'https://a.com',
          title: 'Clean',
          engagement: { upvotes: 100, comments: 10 },
        }),
      ],
      'clean'
    );
    const degraded = makeCluster(
      [
        makeItem({
          url: 'https://b.com',
          title: 'Degraded',
          engagement: { upvotes: 100, comments: 10 },
          provenance: 'degraded',
        }),
      ],
      'degraded'
    );
    const result = rankScore([degraded, clean], { topic: 'test', nowIso: NOW_ISO });
    expect(result[0]?.id).toBe('clean');
  });

  test('per-author cap limits items per author', () => {
    const manyFromOneAuthor = Array.from({ length: 10 }, (_, i) =>
      makeItem({ url: `https://example.com/${i}`, title: `Post ${i}`, author: 'prolific-author' })
    );
    const cluster = makeCluster(manyFromOneAuthor, 'many');
    const result = rankScore([cluster], { topic: 'test', nowIso: NOW_ISO, maxPerAuthor: 3 });
    const authorCount = result[0]?.items.filter((i) => i.author === 'prolific-author').length ?? 0;
    expect(authorCount).toBeLessThanOrEqual(3);
  });

  test('fresher cluster ranks higher than older cluster with same engagement', () => {
    const fresh = makeCluster(
      [makeItem({ url: 'https://a.com', title: 'Fresh', publishedAt: '2026-06-11T11:00:00Z' })],
      'fresh'
    );
    const stale = makeCluster(
      [makeItem({ url: 'https://b.com', title: 'Stale', publishedAt: '2026-05-01T00:00:00Z' })],
      'stale'
    );
    const result = rankScore([stale, fresh], { topic: 'test', nowIso: NOW_ISO });
    expect(result[0]?.id).toBe('fresh');
  });

  test('deterministic: same inputs + same nowIso produces same order', () => {
    const clusters = [
      makeCluster(
        [makeItem({ url: 'https://a.com', title: 'A', engagement: { upvotes: 50, comments: 5 } })],
        'a'
      ),
      makeCluster(
        [makeItem({ url: 'https://b.com', title: 'B', engagement: { upvotes: 80, comments: 8 } })],
        'b'
      ),
    ];
    const first = rankScore(clusters, { topic: 'test', nowIso: NOW_ISO }).map((c) => c.id);
    const second = rankScore(clusters, { topic: 'test', nowIso: NOW_ISO }).map((c) => c.id);
    expect(first).toEqual(second);
  });

  test('empty input returns empty array', () => {
    expect(rankScore([], { topic: 'test', nowIso: NOW_ISO })).toEqual([]);
  });
});
