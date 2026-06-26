import { type } from "arktype";
import type { Cluster } from "./cluster-merge";
import type { ResearchItem, SourceLabel } from "./schema";

export const RankScoreOptions = type({
  topic: "string",
  nowIso: "string",
  "maxPerAuthor?": "number",
});
export type RankScoreOptions = typeof RankScoreOptions.infer;

// `relevance` is the cluster's best item-relevance in [0, 100] (LLM rerank score
// when present, else deterministic entity grounding). Surfaced alongside `score`
// so the report can apply a relevance floor — dropping off-topic clusters that a
// thin topic would otherwise pad the brief with — without recomputing grounding.
export type RankedCluster = Cluster & { score: number; relevance: number };

// Per-source quality weight, ported from the reference engine's SOURCE_QUALITY
// (signals.py). Grounding-heavy sources (HN, YouTube) sit above social-noise
// sources (Reddit, TikTok). GitHub is absent upstream and takes the default —
// its star count is deliberately NOT treated as engagement (see localRelevance).
// TODO(CL-2411 follow-up): tune a dedicated GitHub quality weight; the 0.6
// default currently matches Reddit, which under-rates a high-star repo.
const SOURCE_QUALITY: Partial<Record<SourceLabel, number>> = {
  hn: 0.8,
  youtube: 0.85,
  x: 0.68,
  bluesky: 0.66,
  reddit: 0.6,
  polymarket: 0.5,
  instagram: 0.58,
  tiktok: 0.58,
};
const DEFAULT_SOURCE_QUALITY = 0.6;

function sourceQuality(cluster: Cluster): number {
  let best = 0;
  for (const source of cluster.sources) {
    const q = SOURCE_QUALITY[source] ?? DEFAULT_SOURCE_QUALITY;
    if (q > best) best = q;
  }
  return best === 0 ? DEFAULT_SOURCE_QUALITY : best;
}

// Per-source engagement weight (W1.4). The reference weights engagement by
// source because a vote means different things per platform. We scale the
// engagement nudge by the cluster's best-weighted source: real-engagement
// sources (Reddit, X) count fully; link/search results (web) and GitHub (whose
// stars are not engagement) are discounted so their raw counts carry little.
const ENGAGEMENT_SOURCE_WEIGHT: Partial<Record<SourceLabel, number>> = {
  reddit: 1,
  x: 1,
  hn: 0.9,
  youtube: 0.9,
  bluesky: 0.8,
  instagram: 0.7,
  tiktok: 0.7,
  polymarket: 0.5,
  web: 0.3,
  github: 0.2,
};
const DEFAULT_ENGAGEMENT_SOURCE_WEIGHT = 0.5;

function engagementSourceWeight(cluster: Cluster): number {
  let best = 0;
  for (const source of cluster.sources) {
    const w =
      ENGAGEMENT_SOURCE_WEIGHT[source] ?? DEFAULT_ENGAGEMENT_SOURCE_WEIGHT;
    if (w > best) best = w;
  }
  return best === 0 ? DEFAULT_ENGAGEMENT_SOURCE_WEIGHT : best;
}

// Lowercase word tokens of the topic, used to ground candidates. Mirrors the
// reference's head-token grounding. Kept at length >= 2 so real short topics
// ("AI", "ML", "Go", "3D") still ground; word-boundary matching below makes the
// short tokens safe (no substring false positives).
function topicTokens(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// Whole-word token set of an item's text. Word-boundary matching avoids the
// substring trap (token "art" must not ground on "start"/"smart").
function itemWords(item: ResearchItem): Set<string> {
  const parts = [item.title, item.author ?? "", item.entityTag ?? ""];
  if (item.topComments !== undefined) {
    for (const c of item.topComments) parts.push(c.text);
  }
  return new Set(
    parts
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// Deterministic local relevance in [0, 100]. An explicit per-item `relevance`
// (from the LLM rerank step) dominates when present. Otherwise we ground on the
// topic tokens: a grounded candidate gets the base, an ungrounded one eats the
// entity-miss penalty. The penalty is sized so the grounded-vs-ungrounded gap,
// after RELEVANCE_WEIGHT, strictly exceeds the maximum combined swing of the
// secondary terms (see the weight comment below) — relevance must dominate, not
// merely lead. Mirrors the reference fallback (rerank.py L485-517).
const RELEVANCE_BASE = 60;
const ENTITY_MISS_PENALTY = 40;

function itemRelevance(item: ResearchItem, tokens: string[]): number {
  if (item.relevance !== undefined) {
    return Math.max(0, Math.min(item.relevance, 100));
  }
  if (tokens.length === 0) return RELEVANCE_BASE;
  const words = itemWords(item);
  const grounded = tokens.some((t) => words.has(t));
  return grounded ? RELEVANCE_BASE : RELEVANCE_BASE - ENTITY_MISS_PENALTY;
}

function clusterRelevance(items: ResearchItem[], tokens: string[]): number {
  let best = 0;
  for (const item of items) {
    const r = itemRelevance(item, tokens);
    if (r > best) best = r;
  }
  return best;
}

// Stars are intentionally excluded: a repo's star count is not an upvote and
// must not feed the engagement signal (it is a relevance hint instead).
function engagementScore(items: ResearchItem[]): number {
  const total = items.reduce((sum, item) => {
    if (item.engagement === undefined) return sum;
    return (
      sum + (item.engagement.upvotes ?? 0) + (item.engagement.comments ?? 0)
    );
  }, 0);
  return Math.log(total + 1);
}

function freshnessScore(items: ResearchItem[], nowMs: number): number {
  const mostRecent = items.reduce((best, item) => {
    const t = new Date(item.publishedAt).getTime();
    return t > best ? t : best;
  }, 0);
  const ageMs = nowMs - mostRecent;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  // Clamp to [0, 1]. The upper clamp matters for sources whose `publishedAt` is a
  // future date — Polymarket emits the market END date — so a future-dated item
  // cannot earn a freshness bonus above a brand-new post and over-rank on dating
  // alone.
  return Math.max(0, Math.min(1, 1 - ageMs / thirtyDaysMs));
}

function sourceBreadthBonus(cluster: Cluster): number {
  const extra = cluster.sources.size - 1;
  return Math.min(extra * 0.3, 0.6);
}

function degradedPenalty(items: ResearchItem[]): number {
  return items.some((i) => i.provenance === "degraded") ? 0.25 : 0;
}

// A highly-upvoted top comment is a strong "voice of the people" signal (a
// 1000-upvote reply often outweighs the parent post). Mirrors the reference
// skill's dedicated top-comment slot: capped so it nudges ordering without
// dominating engagement/freshness. log10(1000)/10 = 0.3 is the ceiling.
const MAX_TOP_COMMENT_BONUS = 0.3;

function topCommentBonus(items: ResearchItem[]): number {
  let bestScore = 0;
  for (const item of items) {
    if (item.topComments === undefined) continue;
    for (const comment of item.topComments) {
      if (comment.score > bestScore) bestScore = comment.score;
    }
  }
  if (bestScore <= 0) return 0;
  // Clamp the lower bound: a fractional comment score makes log10 negative, which
  // would turn the bonus into a silent penalty below a comment-less cluster.
  return Math.max(
    0,
    Math.min(Math.log10(bestScore) / 10, MAX_TOP_COMMENT_BONUS),
  );
}

function capPerAuthor(items: ResearchItem[], max: number): ResearchItem[] {
  const counts = new Map<string, number>();
  const result: ResearchItem[] = [];
  for (const item of items) {
    const author = item.author ?? "__unknown__";
    const count = counts.get(author) ?? 0;
    if (count < max) {
      result.push(item);
      counts.set(author, count + 1);
    }
  }
  return result;
}

// Composite weights, ported from the reference final_score (rerank.py L545-568)
// adapted to deterministic cluster scoring. The terms are deliberately on
// DIFFERENT scales so relevance dominates by construction:
//   relevance contribution   0.6 * [20..100]   -> span up to ~48 deterministically
//   freshness contribution    10 * [0..1]       -> up to 10
//   source-quality            5 * [0.5..0.85]   -> ~2.5..4.25
//   engagement nudge          5 * [0..1]         -> up to 5
//   breadth (<=0.6) + topComment (<=0.3)         -> <1
// Deterministic grounded-vs-ungrounded relevance gap is 0.6 * (60-20) = 24, which
// strictly exceeds the maximum combined secondary swing (~10 + 5 + 1.75 + 0.9 =
// ~17.65). So a grounded-but-stale cluster cannot be flipped by a fresh, viral,
// multi-source off-topic one. Retune ENTITY_MISS_PENALTY / FRESHNESS_WEIGHT
// together if these change.
const RELEVANCE_WEIGHT = 0.6;
const FRESHNESS_WEIGHT = 10;
const SOURCE_QUALITY_WEIGHT = 5;
const ENGAGEMENT_NUDGE_MAX = 5;

export function rankScore(
  clusters: Cluster[],
  opts: RankScoreOptions,
): RankedCluster[] {
  const maxPerAuthor = opts.maxPerAuthor ?? 3;
  const nowMs = new Date(opts.nowIso).getTime();
  const tokens = topicTokens(opts.topic);

  // Cap per author once per cluster. capPerAuthor keeps the first N items per
  // author in cluster.items order, so determinism depends on that order being
  // stable — it is (clusterMerge preserves insertion order, which the pipeline
  // feeds in a stable date-sorted order).
  const prepared = clusters.map((cluster) => ({
    cluster,
    cappedItems: capPerAuthor(cluster.items, maxPerAuthor),
  }));
  const maxEngagement = Math.max(
    ...prepared.map((p) => engagementScore(p.cappedItems)),
    1,
  );

  const scored = prepared.map(({ cluster, cappedItems }) => {
    const relevance = clusterRelevance(cappedItems, tokens);
    const normalizedEngagement = engagementScore(cappedItems) / maxEngagement;
    const freshness = freshnessScore(cappedItems, nowMs);
    const breadth = sourceBreadthBonus(cluster);
    const fun = topCommentBonus(cappedItems);
    const penalty = degradedPenalty(cappedItems);
    const score =
      RELEVANCE_WEIGHT * relevance +
      FRESHNESS_WEIGHT * freshness +
      SOURCE_QUALITY_WEIGHT * sourceQuality(cluster) +
      ENGAGEMENT_NUDGE_MAX *
        normalizedEngagement *
        engagementSourceWeight(cluster) +
      breadth +
      fun -
      penalty;
    const topItem = cappedItems.includes(cluster.topItem)
      ? cluster.topItem
      : (cappedItems[0] ?? cluster.topItem);
    return {
      cluster: { ...cluster, items: cappedItems, topItem },
      score,
      relevance,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = new Date(a.cluster.topItem.publishedAt).getTime();
    const bTime = new Date(b.cluster.topItem.publishedAt).getTime();
    return bTime - aTime;
  });

  return scored.map((s) => ({
    ...s.cluster,
    score: s.score,
    relevance: s.relevance,
  }));
}
