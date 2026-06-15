import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import {
  BestTake,
  BriefCluster,
  Citation,
  Engagement,
  Report,
  ReportStats,
  ResearchItem,
  SourceLabel,
  TopComment,
} from './schema';

const baseStats = {
  sourceCount: 1,
  itemCount: 1,
  dateRange: { from: '2026-06-01T12:00:00Z', to: '2026-06-10T12:00:00Z' },
};

const baseItem = {
  url: 'https://news.ycombinator.com/item?id=1',
  title: 'Test post',
  publishedAt: '2026-06-01T12:00:00Z',
  source: 'hn' as const,
  engagement: { upvotes: 100, comments: 50 },
};

describe('SourceLabel', () => {
  test('accepts valid source strings', () => {
    const sources = [
      'hn',
      'github',
      'polymarket',
      'reddit',
      'x',
      'web',
      'tiktok',
      'instagram',
      'threads',
      'pinterest',
      'youtube',
      'bluesky',
    ];
    for (const source of sources) {
      expect(SourceLabel(source) instanceof type.errors).toBe(false);
    }
  });

  test('rejects unknown source strings', () => {
    expect(SourceLabel('twitter') instanceof type.errors).toBe(true);
    expect(SourceLabel('') instanceof type.errors).toBe(true);
  });
});

describe('Engagement', () => {
  test('accepts valid engagement with required fields only', () => {
    const result = Engagement({ upvotes: 10, comments: 5 });
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts valid engagement with all optional fields', () => {
    const result = Engagement({ upvotes: 10, comments: 5, views: 1000, shares: 20 });
    expect(result instanceof type.errors).toBe(false);
  });

  test('rejects engagement missing required fields', () => {
    expect(Engagement({ upvotes: 10 }) instanceof type.errors).toBe(true);
    expect(Engagement({}) instanceof type.errors).toBe(true);
  });
});

describe('ResearchItem', () => {
  test('accepts valid item with required fields only', () => {
    const result = ResearchItem(baseItem);
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts valid item with all optional fields', () => {
    const result = ResearchItem({
      ...baseItem,
      provenance: 'degraded',
      entityTag: 'r/programming',
      author: 'testuser',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('optional fields are absent by default', () => {
    const result = ResearchItem(baseItem);
    if (result instanceof type.errors) throw new Error('unexpected validation error');
    expect('provenance' in result).toBe(false);
    expect('entityTag' in result).toBe(false);
    expect('author' in result).toBe(false);
  });

  test('rejects item missing url', () => {
    const { url: _url, ...withoutUrl } = baseItem;
    expect(ResearchItem(withoutUrl) instanceof type.errors).toBe(true);
  });

  test('rejects item with invalid source', () => {
    expect(ResearchItem({ ...baseItem, source: 'unknown' }) instanceof type.errors).toBe(true);
  });

  test('rejects item with invalid provenance', () => {
    expect(ResearchItem({ ...baseItem, provenance: 'unknown' }) instanceof type.errors).toBe(true);
  });

  test('accepts provenance: standard', () => {
    const result = ResearchItem({ ...baseItem, provenance: 'standard' });
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts web item with no engagement', () => {
    const result = ResearchItem({
      url: 'https://example.com',
      title: 'Web Item',
      publishedAt: '2026-06-01T12:00:00Z',
      source: 'web',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts x item with no engagement', () => {
    const result = ResearchItem({
      url: 'https://x.com/post/1',
      title: 'X Post',
      publishedAt: '2026-06-01T12:00:00Z',
      source: 'x',
    });
    expect(result instanceof type.errors).toBe(false);
  });
});

describe('Citation', () => {
  test('accepts valid citation', () => {
    const result = Citation({
      url: 'https://example.com',
      source: 'web',
      retrievedAt: '2026-06-01T12:00:00Z',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts citation with optional title', () => {
    const result = Citation({
      url: 'https://example.com',
      source: 'hn',
      retrievedAt: '2026-06-01T12:00:00Z',
      title: 'Example',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('rejects citation missing required fields', () => {
    expect(Citation({ url: 'https://example.com', source: 'web' }) instanceof type.errors).toBe(
      true
    );
  });
});

describe('TopComment', () => {
  test('accepts a comment with author', () => {
    const result = TopComment({ text: 'Where is the limewire link', author: 'u/joe', score: 1338 });
    expect(result instanceof type.errors).toBe(false);
  });

  test('rejects a comment missing score', () => {
    expect(TopComment({ text: 'no score' }) instanceof type.errors).toBe(true);
  });
});

describe('ResearchItem enrichment fields', () => {
  test('accepts an item with topComments', () => {
    const result = ResearchItem({
      ...baseItem,
      topComments: [{ text: 'great take', score: 42 }],
    });
    expect(result instanceof type.errors).toBe(false);
  });
});

describe('BriefCluster', () => {
  test('accepts a cluster with required fields', () => {
    const result = BriefCluster({
      id: 'cluster-1',
      title: 'Headline',
      score: 1.5,
      sources: ['hn', 'reddit'],
      items: [baseItem],
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('rejects a cluster missing score', () => {
    expect(
      BriefCluster({ id: 'c', title: 't', sources: ['hn'], items: [] }) instanceof type.errors
    ).toBe(true);
  });
});

describe('BestTake', () => {
  test('accepts a best take', () => {
    const result = BestTake({
      quote: 'this changes everything',
      author: 'u/jane',
      source: 'reddit',
      engagement: 900,
      url: 'https://reddit.com/x',
    });
    expect(result instanceof type.errors).toBe(false);
  });
});

describe('ReportStats', () => {
  test('accepts stats with a date range', () => {
    const result = ReportStats(baseStats);
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts stats without a dateRange (empty coverage window)', () => {
    expect(ReportStats({ sourceCount: 0, itemCount: 0 }) instanceof type.errors).toBe(false);
  });
});

describe('Report', () => {
  test('accepts valid report', () => {
    const result = Report({
      topic: 'AI',
      days: 30,
      stats: baseStats,
      leadInsight: 'Test post',
      clusters: [{ id: 'c1', title: 'Test post', score: 1.2, sources: ['hn'], items: [baseItem] }],
      bestTakes: [],
      items: [baseItem],
      citations: [{ url: baseItem.url, source: 'hn', retrievedAt: '2026-06-11T00:00:00Z' }],
      generatedAt: '2026-06-11T00:00:00Z',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('accepts report with empty items and citations', () => {
    const result = Report({
      topic: 'AI',
      days: 7,
      stats: { sourceCount: 0, itemCount: 0, dateRange: baseStats.dateRange },
      clusters: [],
      bestTakes: [],
      items: [],
      citations: [],
      generatedAt: '2026-06-11T00:00:00Z',
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test('rejects report missing topic', () => {
    expect(
      Report({
        days: 30,
        stats: baseStats,
        clusters: [],
        bestTakes: [],
        items: [],
        citations: [],
        generatedAt: '2026-06-11T00:00:00Z',
      }) instanceof type.errors
    ).toBe(true);
  });

  test('rejects report missing stats', () => {
    expect(
      Report({
        topic: 'AI',
        days: 30,
        clusters: [],
        bestTakes: [],
        items: [],
        citations: [],
        generatedAt: '2026-06-11T00:00:00Z',
      }) instanceof type.errors
    ).toBe(true);
  });
});
