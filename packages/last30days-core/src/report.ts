import { clusterMerge } from './cluster-merge';
import { dateFilter } from './date-filter';
import { dedupe } from './dedupe';
import { rankScore } from './rank-score';
import type { Report, ResearchItem } from './schema';

export function buildReport(
  rawItems: ResearchItem[],
  opts: { topic: string; days: number; topK: number; nowIso: string }
): Report {
  const windowed = dateFilter(rawItems, { days: opts.days, nowIso: opts.nowIso });
  const deduped = dedupe(windowed);
  const clusters = clusterMerge(deduped);
  const ranked = rankScore(clusters, { topic: opts.topic, nowIso: opts.nowIso });
  const topItems = ranked.slice(0, opts.topK).flatMap((c) => c.items);

  return {
    topic: opts.topic,
    days: opts.days,
    items: topItems,
    citations: topItems.map((item) => ({
      url: item.url,
      source: item.source,
      retrievedAt: opts.nowIso,
      title: item.title,
    })),
    generatedAt: opts.nowIso,
  };
}
