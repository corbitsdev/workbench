import { describe, expect, test } from 'bun:test';
import { buildReport } from './report';
import type { ResearchItem } from './schema';

const NOW_ISO = '2026-06-11T12:00:00Z';

function makeItem(overrides: Partial<ResearchItem> & { url: string; title: string }): ResearchItem {
  return {
    publishedAt: '2026-06-05T12:00:00Z',
    source: 'hn',
    engagement: { upvotes: 50, comments: 10 },
    ...overrides,
  };
}

const FIXTURE: ResearchItem[] = [
  makeItem({
    url: 'https://a.com',
    title: 'Alpha post about TypeScript',
    engagement: { upvotes: 200, comments: 40 },
  }),
  makeItem({
    url: 'https://b.com',
    title: 'Beta post about Rust',
    source: 'reddit',
    engagement: { upvotes: 150, comments: 30 },
  }),
  makeItem({
    url: 'https://c.com',
    title: 'Gamma post about Go',
    engagement: { upvotes: 100, comments: 20 },
  }),
  makeItem({
    url: 'https://d.com',
    title: 'Delta post about Python',
    source: 'github',
    engagement: { upvotes: 80, comments: 15 },
  }),
  makeItem({
    url: 'https://e.com',
    title: 'Epsilon post about Elixir',
    engagement: { upvotes: 60, comments: 12 },
  }),
  makeItem({
    url: 'https://f.com',
    title: 'Old post that should be filtered',
    publishedAt: '2026-01-01T00:00:00Z',
    engagement: { upvotes: 9999, comments: 999 },
  }),
];

describe('buildReport', () => {
  test('returns a Report with the correct topic and days', () => {
    const report = buildReport(FIXTURE, {
      topic: 'programming languages',
      days: 30,
      topK: 5,
      nowIso: NOW_ISO,
    });
    expect(report.topic).toBe('programming languages');
    expect(report.days).toBe(30);
    expect(report.generatedAt).toBe(NOW_ISO);
  });

  test('filters out items older than the window', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 10, nowIso: NOW_ISO });
    const urls = report.items.map((i) => i.url);
    expect(urls).not.toContain('https://f.com');
  });

  test('respects topK — returns at most topK clusters worth of items', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 2, nowIso: NOW_ISO });
    expect(report.items.length).toBeLessThanOrEqual(2);
  });

  test('citations match items in url and source', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    for (const citation of report.citations) {
      const matchingItem = report.items.find((i) => i.url === citation.url);
      if (!matchingItem) throw new Error(`citation url ${citation.url} has no matching item`);
      expect(citation.source).toBe(matchingItem.source);
    }
  });

  test('citations use nowIso as retrievedAt', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    for (const citation of report.citations) {
      expect(citation.retrievedAt).toBe(NOW_ISO);
    }
  });

  test('golden output: deterministic given fixed inputs and nowIso', () => {
    const first = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 3, nowIso: NOW_ISO });
    const second = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 3, nowIso: NOW_ISO });
    expect(first.items.map((i) => i.url)).toEqual(second.items.map((i) => i.url));
    expect(first.citations.map((c) => c.url)).toEqual(second.citations.map((c) => c.url));
  });

  test('empty input returns empty report', () => {
    const report = buildReport([], { topic: 'empty', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.items).toHaveLength(0);
    expect(report.citations).toHaveLength(0);
  });

  test('exposes ranked clusters with scores and source labels', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.clusters.length).toBeGreaterThan(0);
    const first = report.clusters[0];
    if (!first) throw new Error('expected at least one cluster');
    const topItem = first.items[0];
    if (!topItem) throw new Error('expected the cluster to have items');
    expect(typeof first.score).toBe('number');
    expect(first.sources.length).toBeGreaterThan(0);
    expect(first.title).toBe(topItem.title);
  });

  test('clusters are ordered by descending score', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 10, nowIso: NOW_ISO });
    const scores = report.clusters.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  test('stats reflect item count, source breadth, and date range', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 10, nowIso: NOW_ISO });
    expect(report.stats.itemCount).toBe(report.items.length);
    expect(report.stats.sourceCount).toBe(new Set(report.items.map((i) => i.source)).size);
    const dateRange = report.stats.dateRange;
    if (!dateRange) throw new Error('expected a dateRange for a non-empty report');
    expect(new Date(dateRange.from).getTime()).toBeLessThanOrEqual(
      new Date(dateRange.to).getTime()
    );
  });

  test('leadInsight is the top cluster headline', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.leadInsight).toBe(report.clusters[0]?.title);
  });

  test('bestTakes are drawn from item topComments, ranked by comment score', () => {
    const enriched: ResearchItem[] = [
      makeItem({
        url: 'https://q.com',
        title: 'Quip thread',
        source: 'reddit',
        topComments: [
          { text: 'low signal', score: 5 },
          { text: 'the killer quote', author: 'u/ace', score: 1338 },
        ],
      }),
    ];
    const report = buildReport(enriched, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.bestTakes[0]?.quote).toBe('the killer quote');
    expect(report.bestTakes[0]?.engagement).toBe(1338);
    expect(report.bestTakes[0]?.url).toBe('https://q.com');
  });

  test('bestTakes is empty when no items carry top comments', () => {
    const report = buildReport(FIXTURE, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.bestTakes).toHaveLength(0);
  });

  test('bestTakes dedupes the same quote cross-posted across sources', () => {
    const enriched: ResearchItem[] = [
      makeItem({
        url: 'https://hn.com',
        title: 'HN thread',
        source: 'hn',
        topComments: [{ text: 'Same killer line', score: 900 }],
      }),
      makeItem({
        url: 'https://reddit.com',
        title: 'Reddit thread',
        source: 'reddit',
        topComments: [{ text: 'same killer line', score: 400 }],
      }),
    ];
    const report = buildReport(enriched, { topic: 'test', days: 30, topK: 5, nowIso: NOW_ISO });
    const quotes = report.bestTakes.map((t) => t.quote.toLowerCase());
    expect(quotes.filter((q) => q === 'same killer line')).toHaveLength(1);
  });

  test('omits dateRange when there are no items', () => {
    const report = buildReport([], { topic: 'empty', days: 30, topK: 5, nowIso: NOW_ISO });
    expect(report.stats.itemCount).toBe(0);
    expect(report.stats.dateRange).toBeUndefined();
  });
});
