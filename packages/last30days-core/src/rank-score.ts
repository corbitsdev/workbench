import type { Cluster } from './cluster-merge';
import type { ResearchItem } from './schema';

export type RankScoreOptions = {
  topic: string;
  nowIso: string;
  maxPerAuthor?: number;
};

function engagementScore(items: ResearchItem[]): number {
  const total = items.reduce(
    (sum, item) => sum + item.engagement.upvotes + item.engagement.comments,
    0
  );
  return Math.log(total + 1);
}

function freshnessScore(items: ResearchItem[], nowMs: number): number {
  const mostRecent = items.reduce((best, item) => {
    const t = new Date(item.publishedAt).getTime();
    return t > best ? t : best;
  }, 0);
  const ageMs = nowMs - mostRecent;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - ageMs / thirtyDaysMs);
}

function sourceBreadthBonus(cluster: Cluster): number {
  const extra = cluster.sources.size - 1;
  return Math.min(extra * 0.3, 0.6);
}

function degradedPenalty(items: ResearchItem[]): number {
  return items.some((i) => i.provenance === 'degraded') ? 0.25 : 0;
}

function capPerAuthor(items: ResearchItem[], max: number): ResearchItem[] {
  const counts = new Map<string, number>();
  const result: ResearchItem[] = [];
  for (const item of items) {
    const author = item.author ?? '__unknown__';
    const count = counts.get(author) ?? 0;
    if (count < max) {
      result.push(item);
      counts.set(author, count + 1);
    }
  }
  return result;
}

export function rankScore(clusters: Cluster[], opts: RankScoreOptions): Cluster[] {
  const maxPerAuthor = opts.maxPerAuthor ?? 3;
  const nowMs = new Date(opts.nowIso).getTime();

  const pool = [...clusters];
  const maxEngagement = Math.max(...pool.map((c) => engagementScore(c.items)), 1);

  const scored = pool.map((cluster) => {
    const cappedItems = capPerAuthor(cluster.items, maxPerAuthor);
    const normalizedEngagement = engagementScore(cappedItems) / maxEngagement;
    const freshness = freshnessScore(cappedItems, nowMs);
    const breadth = sourceBreadthBonus(cluster);
    const penalty = degradedPenalty(cappedItems);
    const score = normalizedEngagement + freshness + breadth - penalty;
    const topItem = cappedItems.includes(cluster.topItem)
      ? cluster.topItem
      : (cappedItems[0] ?? cluster.topItem);
    return { cluster: { ...cluster, items: cappedItems, topItem }, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = new Date(a.cluster.topItem.publishedAt).getTime();
    const bTime = new Date(b.cluster.topItem.publishedAt).getTime();
    return bTime - aTime;
  });

  return scored.map((s) => s.cluster);
}
