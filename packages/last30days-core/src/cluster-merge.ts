import type { ResearchItem } from "./schema";

export type Cluster = {
  id: string;
  items: ResearchItem[];
  sources: Set<ResearchItem["source"]>;
  topItem: ResearchItem;
};

function normalizeTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function findClusterFor(
  clusters: Cluster[],
  item: ResearchItem,
): Cluster | undefined {
  const itemTokens = normalizeTokens(item.title);

  for (const cluster of clusters) {
    const top = cluster.topItem;

    if (top.url === item.url) return cluster;

    if (
      item.entityTag !== undefined &&
      item.entityTag !== "" &&
      top.entityTag === item.entityTag
    ) {
      return cluster;
    }

    const topTokens = normalizeTokens(top.title);
    if (jaccardSimilarity(itemTokens, topTokens) >= 0.8) return cluster;
  }

  return undefined;
}

export function clusterMerge(items: ResearchItem[]): Cluster[] {
  let clusterCounter = 0;
  const clusters: Cluster[] = [];

  for (const item of items) {
    const existing = findClusterFor(clusters, item);
    if (existing !== undefined) {
      existing.items.push(item);
      existing.sources.add(item.source);
    } else {
      clusters.push({
        id: `cluster-${++clusterCounter}`,
        items: [item],
        sources: new Set([item.source]),
        topItem: item,
      });
    }
  }

  return clusters;
}
