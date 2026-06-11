import { describe, expect, test } from 'bun:test';
import { clusterMerge } from './cluster-merge';
import type { ResearchItem } from './schema';

function makeItem(overrides: Partial<ResearchItem> & { url: string; title: string }): ResearchItem {
  return {
    publishedAt: '2026-06-01T12:00:00Z',
    source: 'hn',
    engagement: { upvotes: 10, comments: 5 },
    ...overrides,
  };
}

describe('clusterMerge', () => {
  test('distinct items form separate clusters', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Alpha story' }),
      makeItem({ url: 'https://b.com', title: 'Beta story' }),
      makeItem({ url: 'https://c.com', title: 'Gamma story' }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(3);
  });

  test('same URL across two sources merges into one cluster', () => {
    const items = [
      makeItem({ url: 'https://example.com/story', title: 'Story', source: 'hn' }),
      makeItem({ url: 'https://example.com/story', title: 'Story', source: 'reddit' }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.items).toHaveLength(2);
    expect(clusters[0]?.sources.size).toBe(2);
  });

  test('matching entityTag merges items from different sources', () => {
    const items = [
      makeItem({
        url: 'https://hn.com/1',
        title: 'Rust discussion on HN',
        source: 'hn',
        entityTag: 'rust-lang',
      }),
      makeItem({
        url: 'https://reddit.com/1',
        title: 'Rust thread on Reddit',
        source: 'reddit',
        entityTag: 'rust-lang',
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sources.size).toBe(2);
  });

  test('null entityTag does not merge with non-null entityTag', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Post A', source: 'hn' }),
      makeItem({ url: 'https://b.com', title: 'Post B', source: 'reddit', entityTag: 'some-tag' }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(2);
  });

  test('high Jaccard title similarity merges items', () => {
    const items = [
      makeItem({
        url: 'https://hn.com/1',
        title: 'How to write fast Rust code for production',
        source: 'hn',
      }),
      makeItem({
        url: 'https://blog.com/1',
        title: 'How to write fast Rust code for production systems',
        source: 'web',
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
  });

  test('low Jaccard title similarity does not merge items', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Rust programming language release', source: 'hn' }),
      makeItem({
        url: 'https://b.com',
        title: 'Python machine learning tutorial for beginners guide',
        source: 'web',
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(2);
  });

  test('cluster sources set tracks all unique sources', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Same story', source: 'hn', entityTag: 'tag-x' }),
      makeItem({
        url: 'https://b.com',
        title: 'Same story link',
        source: 'reddit',
        entityTag: 'tag-x',
      }),
      makeItem({
        url: 'https://c.com',
        title: 'Same story coverage',
        source: 'github',
        entityTag: 'tag-x',
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sources).toContain('hn');
    expect(clusters[0]?.sources).toContain('reddit');
    expect(clusters[0]?.sources).toContain('github');
  });

  test('empty input returns empty array', () => {
    expect(clusterMerge([])).toEqual([]);
  });
});
