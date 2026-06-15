import { clusterMerge } from './cluster-merge';
import { dateFilter } from './date-filter';
import { dedupe } from './dedupe';
import { rankScore, type RankedCluster } from './rank-score';
import type { BestTake, BriefCluster, Report, ResearchItem } from './schema';

const MAX_BEST_TAKES = 5;

function buildStats(items: ResearchItem[], nowIso: string): Report['stats'] {
  const sourceCount = new Set(items.map((item) => item.source)).size;
  if (items.length === 0) {
    return { sourceCount: 0, itemCount: 0, dateRange: { from: nowIso, to: nowIso } };
  }
  const times = items.map((item) => new Date(item.publishedAt).getTime());
  const from = new Date(Math.min(...times)).toISOString();
  const to = new Date(Math.max(...times)).toISOString();
  return { sourceCount, itemCount: items.length, dateRange: { from, to } };
}

function toBriefCluster(cluster: RankedCluster): BriefCluster {
  return {
    id: cluster.id,
    title: cluster.topItem.title,
    score: cluster.score,
    sources: [...cluster.sources],
    items: cluster.items,
  };
}

function collectBestTakes(items: ResearchItem[]): BestTake[] {
  const takes: BestTake[] = [];
  for (const item of items) {
    if (item.topComments === undefined) continue;
    for (const comment of item.topComments) {
      const take: BestTake = {
        quote: comment.text,
        source: item.source,
        engagement: comment.score,
        url: item.url,
      };
      if (comment.author !== undefined) {
        take.author = comment.author;
      }
      takes.push(take);
    }
  }
  takes.sort((a, b) => b.engagement - a.engagement);
  return takes.slice(0, MAX_BEST_TAKES);
}

export function buildReport(
  rawItems: ResearchItem[],
  opts: { topic: string; days: number; topK: number; nowIso: string }
): Report {
  const windowed = dateFilter(rawItems, { days: opts.days, nowIso: opts.nowIso });
  const deduped = dedupe(windowed);
  const clusters = clusterMerge(deduped);
  const ranked = rankScore(clusters, { topic: opts.topic, nowIso: opts.nowIso });
  const topClusters = ranked.slice(0, opts.topK);
  const topItems = topClusters.flatMap((cluster) => cluster.items);
  const briefClusters = topClusters.map(toBriefCluster);

  const leadCluster = topClusters[0];

  const report: Report = {
    topic: opts.topic,
    days: opts.days,
    stats: buildStats(topItems, opts.nowIso),
    clusters: briefClusters,
    bestTakes: collectBestTakes(topItems),
    items: topItems,
    citations: topItems.map((item) => ({
      url: item.url,
      source: item.source,
      retrievedAt: opts.nowIso,
      title: item.title,
    })),
    generatedAt: opts.nowIso,
  };
  if (leadCluster !== undefined) {
    report.leadInsight = leadCluster.topItem.title;
  }
  return report;
}
