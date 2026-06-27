import { describe, expect, test } from "bun:test";
import { clusterMerge } from "./cluster-merge";
import type { ResearchItem } from "./schema";

function makeItem(
  overrides: Partial<ResearchItem> & { url: string; title: string },
): ResearchItem {
  return {
    publishedAt: "2026-06-01T12:00:00Z",
    source: "hn",
    engagement: { upvotes: 10, comments: 5 },
    ...overrides,
  };
}

describe("clusterMerge", () => {
  test("distinct items form separate clusters", () => {
    const items = [
      makeItem({ url: "https://a.com", title: "Alpha story" }),
      makeItem({ url: "https://b.com", title: "Beta story" }),
      makeItem({ url: "https://c.com", title: "Gamma story" }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(3);
  });

  test("same URL across two sources merges into one cluster", () => {
    const items = [
      makeItem({
        url: "https://example.com/story",
        title: "Story",
        source: "hn",
      }),
      makeItem({
        url: "https://example.com/story",
        title: "Story",
        source: "reddit",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.items).toHaveLength(2);
    expect(clusters[0]?.sources.size).toBe(2);
  });

  test("matching entityTag merges items from different sources", () => {
    const items = [
      makeItem({
        url: "https://hn.com/1",
        title: "Rust discussion on HN",
        source: "hn",
        entityTag: "rust-lang",
      }),
      makeItem({
        url: "https://reddit.com/1",
        title: "Rust thread on Reddit",
        source: "reddit",
        entityTag: "rust-lang",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sources.size).toBe(2);
  });

  test("null entityTag does not merge with non-null entityTag", () => {
    const items = [
      makeItem({ url: "https://a.com", title: "Post A", source: "hn" }),
      makeItem({
        url: "https://b.com",
        title: "Post B",
        source: "reddit",
        entityTag: "some-tag",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(2);
  });

  test("high Jaccard title similarity merges items", () => {
    const items = [
      makeItem({
        url: "https://hn.com/1",
        title: "How to write fast Rust code for production",
        source: "hn",
      }),
      makeItem({
        url: "https://blog.com/1",
        title: "How to write fast Rust code for production systems",
        source: "web",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
  });

  test("low Jaccard title similarity does not merge items", () => {
    const items = [
      makeItem({
        url: "https://a.com",
        title: "Rust programming language release",
        source: "hn",
      }),
      makeItem({
        url: "https://b.com",
        title: "Python machine learning tutorial for beginners guide",
        source: "web",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(2);
  });

  test("cluster sources set tracks all unique sources", () => {
    const items = [
      makeItem({
        url: "https://a.com",
        title: "Same story",
        source: "hn",
        entityTag: "tag-x",
      }),
      makeItem({
        url: "https://b.com",
        title: "Same story link",
        source: "reddit",
        entityTag: "tag-x",
      }),
      makeItem({
        url: "https://c.com",
        title: "Same story coverage",
        source: "github",
        entityTag: "tag-x",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sources).toContain("hn");
    expect(clusters[0]?.sources).toContain("reddit");
    expect(clusters[0]?.sources).toContain("github");
  });

  test("empty input returns empty array", () => {
    expect(clusterMerge([])).toEqual([]);
  });

  test("entity-overlap pass groups same-entity coverage into one multi-item theme", () => {
    // Five items, three of which cover the same entity ("Cursor agent mode")
    // with different words across different sources, plus two unrelated items.
    // The second pass must fuse the three into one theme (a multi-item cluster)
    // while leaving the unrelated pair as their own clusters — N=5 items into
    // M=3 clusters, the multi-section-brief outcome.
    const items = [
      makeItem({
        url: "https://hn.com/cursor",
        title: "Cursor 2.0 ships autonomous agent mode",
        source: "hn",
      }),
      makeItem({
        url: "https://reddit.com/cursor",
        title: "Hands on with the new Cursor agent mode workflow",
        source: "reddit",
      }),
      makeItem({
        url: "https://yt.com/cursor",
        title: "Cursor agent mode review and autonomous coding demo",
        source: "youtube",
      }),
      makeItem({
        url: "https://hn.com/postgres",
        title: "Postgres 18 logical replication improvements",
        source: "hn",
      }),
      makeItem({
        url: "https://hn.com/kubernetes",
        title: "Kubernetes gateway networking deprecations",
        source: "hn",
      }),
    ];
    const clusters = clusterMerge(items);
    expect(clusters).toHaveLength(3);
    const themed = clusters.find((c) => c.items.length > 1);
    if (!themed) throw new Error("expected one merged multi-item theme");
    expect(themed.items).toHaveLength(3);
    expect(themed.sources.size).toBe(3);
    const singles = clusters.filter((c) => c.items.length === 1);
    expect(singles).toHaveLength(2);
  });

  test("a single shared generic word does not over-merge distinct stories", () => {
    // Both titles share only "release" — one common word is below the
    // entity-overlap bar, so the two stories must stay separate.
    const items = [
      makeItem({ url: "https://a.com", title: "Rust 1.90 release notes" }),
      makeItem({
        url: "https://b.com",
        title: "Python 3.14 release candidate",
        source: "web",
      }),
    ];
    expect(clusterMerge(items)).toHaveLength(2);
  });
});
