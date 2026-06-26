import { clusterMerge } from "./cluster-merge";
import { dateFilter } from "./date-filter";
import { dedupe } from "./dedupe";
import { rankScore, type RankedCluster } from "./rank-score";
import type {
  BestTake,
  BriefCluster,
  Report,
  ResearchItem,
  SkippedSource,
} from "./schema";

const MAX_BEST_TAKES = 5;

function buildStats(items: ResearchItem[], nowIso: string): Report["stats"] {
  const sourceCount = new Set(items.map((item) => item.source)).size;
  if (items.length === 0) {
    // No items means no real coverage window — omit dateRange rather than
    // fabricating a now-to-now span that reads as if data were found.
    return { sourceCount: 0, itemCount: 0 };
  }
  const times = items.map((item) => new Date(item.publishedAt).getTime());
  const from = new Date(Math.min(...times)).toISOString();
  // Clamp the upper bound to now: a source whose `publishedAt` is a future date
  // (Polymarket emits the market end date) must not make the rendered coverage
  // window claim it ends years ahead.
  const nowMs = new Date(nowIso).getTime();
  const to = new Date(Math.min(Math.max(...times), nowMs)).toISOString();
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
  const seenQuotes = new Set<string>();
  for (const item of items) {
    if (item.topComments === undefined) continue;
    for (const comment of item.topComments) {
      const quoteKey = comment.text.trim().toLowerCase();
      // A quote cross-posted across sources (common HN+Reddit) should not waste
      // the limited best-takes budget on duplicates.
      if (seenQuotes.has(quoteKey)) continue;
      seenQuotes.add(quoteKey);
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
  opts: {
    topic: string;
    days: number;
    topK: number;
    nowIso: string;
    // Drop clusters whose best relevance falls below this floor BEFORE taking the
    // top K — so a thin-signal topic returns an honestly-small brief rather than
    // padding `topK` with off-topic noise. On the reference scale 0–39 is
    // off-topic, so a floor of 40 keeps grounded (60) and clearly-relevant LLM
    // scores while cutting the entity-miss (20) tail. Defaults to 0 (no floor) so
    // existing callers are unchanged; the workflow brief opts in.
    minRelevance?: number;
    skippedSources?: SkippedSource[];
  },
): Report {
  const windowed = dateFilter(rawItems, {
    days: opts.days,
    nowIso: opts.nowIso,
  });
  const deduped = dedupe(windowed);
  const clusters = clusterMerge(deduped);
  const ranked = rankScore(clusters, {
    topic: opts.topic,
    nowIso: opts.nowIso,
  });
  const floor = opts.minRelevance ?? 0;
  const grounded =
    floor > 0 ? ranked.filter((cluster) => cluster.relevance >= floor) : ranked;
  const topClusters = grounded.slice(0, opts.topK);
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
  if (opts.skippedSources !== undefined && opts.skippedSources.length > 0) {
    report.skippedSources = opts.skippedSources;
  }
  return report;
}
