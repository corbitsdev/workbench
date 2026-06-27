import { clusterMerge } from "./cluster-merge";
import { dateFilter } from "./date-filter";
import { dedupe } from "./dedupe";
import { qualityFilter } from "./quality-filter";
import { rankScore, type RankedCluster } from "./rank-score";
import type {
  BestTake,
  BriefCluster,
  Curation,
  Report,
  ResearchItem,
  SkippedSource,
} from "./schema";

const MAX_BEST_TAKES = 5;
// A curated brief stays tight even when the curate model over-emits: keep at most
// this many themes (Larry's "3-6 real themes"), choosing the strongest when the
// model returns a one-per-item dump. And aim for at least this many community
// quotes, backfilling from high-engagement post titles when the model selects too
// few (the weak-instruction-follower case — CL-2503).
const MAX_THEMES = 6;
const MIN_BEST_TAKES = 3;

// Sources where a post's own title/engagement is genuine community voice (Larry
// quotes high-vote Reddit/X/HN post titles). Web/GitHub titles are headlines/repo
// names; YouTube/TikTok titles are clickbait/SEO, not a community take — so none
// of those backfill a quote. The curate model may still explicitly quote any
// source; this set only gates the deterministic backfill.
const QUOTABLE_SOURCES = new Set<ResearchItem["source"]>([
  "reddit",
  "x",
  "hn",
  "threads",
  "bluesky",
]);

function itemEngagementTotal(item: ResearchItem): number {
  const e = item.engagement;
  if (e === undefined) return 0;
  return (e.upvotes ?? 0) + (e.comments ?? 0) + (e.views ?? 0);
}

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

// Build a Report from the LLM curate step's structured judgment (CL-2503)
// instead of the deterministic cluster/filter pipeline. The curate model has
// already dropped junk, grouped survivors into named themes, and picked verbatim
// quotes; this only resolves theme item-urls back to the full ResearchItems the
// collect step produced and assembles the stats/citations envelope. Returns null
// when curation resolves to zero themes-with-items so the caller can fall back to
// `buildReport` rather than emit an empty brief.
export function buildReportFromCuration(
  items: ResearchItem[],
  curation: Curation,
  opts: {
    topic: string;
    days: number;
    nowIso: string;
    skippedSources?: SkippedSource[];
  },
): Report | null {
  const byUrl = new Map(items.map((item) => [item.url, item]));
  interface ScoredCluster {
    cluster: BriefCluster;
    items: ResearchItem[];
    modelRank: number;
    engagement: number;
  }
  const scored: ScoredCluster[] = [];
  let clusterIndex = 0;
  for (const theme of curation.themes) {
    const themeItems: ResearchItem[] = [];
    const seenInTheme = new Set<string>();
    for (const url of theme.itemUrls) {
      const item = byUrl.get(url);
      if (item === undefined || seenInTheme.has(url)) continue;
      seenInTheme.add(url);
      themeItems.push(item);
    }
    if (themeItems.length === 0) {
      clusterIndex += 1;
      continue;
    }
    const sources = [...new Set(themeItems.map((item) => item.source))];
    const cluster: BriefCluster = {
      id: `theme-${clusterIndex}`,
      title: theme.title,
      score: 0,
      sources,
      items: themeItems,
    };
    if (theme.summary !== undefined && theme.summary.trim().length > 0) {
      cluster.summary = theme.summary.trim();
    }
    scored.push({
      cluster,
      items: themeItems,
      modelRank: clusterIndex,
      engagement: themeItems.reduce((s, i) => s + itemEngagementTotal(i), 0),
    });
    clusterIndex += 1;
  }

  if (scored.length === 0) return null;

  // Trust the curate model's strongest-first ORDER as primary: the prompt makes it
  // put the intent-matching lede first (the actual launches for a launch topic), so
  // sorting by item count here would wrongly bury a single-article launch under a
  // big multi-post complaint cluster — the recall failure we are fixing. Item count
  // / source breadth / engagement only break ties between same-rank themes. The cap
  // to MAX_THEMES still collapses a one-per-item dump to a tight Larry-style brief.
  scored.sort((a, b) => {
    if (a.modelRank !== b.modelRank) return a.modelRank - b.modelRank;
    if (b.items.length !== a.items.length)
      return b.items.length - a.items.length;
    if (b.cluster.sources.length !== a.cluster.sources.length) {
      return b.cluster.sources.length - a.cluster.sources.length;
    }
    return b.engagement - a.engagement;
  });
  const topScored = scored.slice(0, MAX_THEMES);
  const clusters = topScored.map((s, i) => ({
    ...s.cluster,
    // Descending score reflects the final strongest-first order for the writer.
    score: topScored.length - i,
  }));

  const keptItems: ResearchItem[] = [];
  const seenItemUrls = new Set<string>();
  for (const cluster of clusters) {
    for (const item of cluster.items) {
      if (seenItemUrls.has(item.url)) continue;
      seenItemUrls.add(item.url);
      keptItems.push(item);
    }
  }

  // Community quotes: the model's selections plus, when it returned too few, a
  // backfill from the collected pool's highest-engagement quotable posts the model
  // left out (its themes often skew to web launch articles and miss the Reddit/X
  // reaction). The backfill is RELEVANCE-GATED to the kept themes' entities so it
  // surfaces real reaction to the launches, not the highest-engagement generic
  // scam/complaint thread that merely shares the category word. Any backfilled
  // item is then surfaced into the report's items + citations so its quote is
  // grounded.
  const bestTakes = buildBestTakes(curation, items, keptItems, opts.topic);
  const byUrlAll = new Map(items.map((item) => [item.url, item]));
  for (const take of bestTakes) {
    if (seenItemUrls.has(take.url)) continue;
    const item = byUrlAll.get(take.url);
    if (item === undefined) continue;
    seenItemUrls.add(take.url);
    keptItems.push(item);
  }

  const leadCluster = clusters[0];
  const report: Report = {
    topic: opts.topic,
    days: opts.days,
    stats: buildStats(keptItems, opts.nowIso),
    clusters,
    bestTakes,
    items: keptItems,
    citations: keptItems.map((item) => ({
      url: item.url,
      source: item.source,
      retrievedAt: opts.nowIso,
      title: item.title,
    })),
    generatedAt: opts.nowIso,
  };
  if (leadCluster !== undefined) {
    report.leadInsight = leadCluster.title;
  }
  if (opts.skippedSources !== undefined && opts.skippedSources.length > 0) {
    report.skippedSources = opts.skippedSources;
  }
  return report;
}

// Generic words that must NOT anchor backfill relevance — the topic/category
// nouns and launch verbs every item shares. Without this, a generic "bank scam"
// thread matches a launch brief through the word "bank" and a high-engagement
// off-topic complaint wins the quote slot.
const RELEVANCE_STOPWORDS = new Set([
  "bank",
  "banks",
  "banking",
  "neobank",
  "neobanks",
  "launch",
  "launches",
  "launched",
  "digital",
  "online",
  "app",
  "apps",
  "account",
  "accounts",
  "card",
  "cards",
  "new",
  "first",
  "best",
  "review",
  "reviews",
  "money",
  "credit",
  "debit",
  "fintech",
  "finance",
  "financial",
  "with",
  "that",
  "this",
  "your",
  "from",
  "have",
  "about",
  "into",
  "they",
  "what",
  "which",
  "their",
]);

function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (RELEVANCE_STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

// The raw category tokens of the topic itself (NOT stopword-filtered), used as a
// looser second relevance tier for community quotes: a thread that names the
// category ("best neobank for business?") is on-topic color even when it names no
// specific launch. Length >= 4 keeps it meaningful.
function topicCategoryTokens(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !LAUNCH_ACTION_WORDS.has(t));
}

const LAUNCH_ACTION_WORDS = new Set([
  "launch",
  "launches",
  "launched",
  "release",
  "releases",
  "released",
  "debut",
  "debuts",
  "announcement",
  "announcements",
]);

// A community thread carrying one of these is an unrelated incident (a complaint
// about some pre-existing product), not reaction to a launch — excluded from the
// looser category tier so a viral "my account got frozen" thread never fills a
// quote slot in a launches brief. The precise entity tier is exempt: a "Coverd
// scam?" thread that names a launched product IS legitimate reaction.
const QUOTE_NOISE_WORDS = new Set([
  "scam",
  "scammed",
  "fraud",
  "frozen",
  "unfrozen",
  "hacked",
  "stolen",
  "lawsuit",
  "ripped",
  "locked",
]);

// Assemble the community quotes for a curated brief. The model's selected quotes
// come first (verbatim, attributed). When it returns too few — the
// weak-instruction-follower case where curate emits no quotes at all — backfill
// from the highest-engagement quotable posts the model left out, using the post
// title as the quote (Larry's "high-vote post title as the community signal").
// The backfill is RELEVANCE-GATED: a candidate's title must share a significant
// entity token with the kept themes (the launched products) or the topic, so the
// surfaced quote is genuine reaction to the story — not the loudest generic
// scam/complaint thread that merely repeats the category word. Never invents
// anything: every backfilled quote is a real item's real title with its real
// engagement and author.
function buildBestTakes(
  curation: Curation,
  candidates: ResearchItem[],
  anchorItems: ResearchItem[],
  topic: string,
): BestTake[] {
  const takes: BestTake[] = [];
  const seenQuotes = new Set<string>();
  const seenUrls = new Set<string>();
  for (const quote of curation.quotes) {
    if (!Number.isFinite(quote.engagement)) continue;
    const key = quote.quote.trim().toLowerCase();
    if (key.length === 0 || seenQuotes.has(key)) continue;
    seenQuotes.add(key);
    seenUrls.add(quote.url);
    const take: BestTake = {
      quote: quote.quote,
      source: quote.source,
      engagement: quote.engagement,
      url: quote.url,
    };
    if (quote.author !== undefined) take.author = quote.author;
    takes.push(take);
  }
  takes.sort((a, b) => b.engagement - a.engagement);

  if (takes.length >= MIN_BEST_TAKES) return takes.slice(0, MAX_BEST_TAKES);

  // Tier 1 (precise): the launched-product entity tokens from the kept themes — a
  // community thread that names one is direct reaction to a launch.
  const entityTokens = new Set<string>();
  for (const item of anchorItems) {
    for (const token of significantTokens(item.title)) entityTokens.add(token);
  }
  // Tier 2 (looser): the topic's category tokens — on-topic color that names no
  // specific launch, allowed only when the thread carries no unrelated-incident
  // noise word.
  const categoryTokens = topicCategoryTokens(topic);
  const isRelevant = (item: ResearchItem): boolean => {
    if (entityTokens.size === 0 && categoryTokens.length === 0) return true;
    const lowerTitle = item.title.toLowerCase();
    const titleTokens = significantTokens(item.title);
    for (const token of titleTokens) {
      if (entityTokens.has(token)) return true;
    }
    const hasNoise = [...QUOTE_NOISE_WORDS].some((w) => lowerTitle.includes(w));
    if (hasNoise) return false;
    return categoryTokens.some((t) => lowerTitle.includes(t));
  };

  const backfill = candidates
    .filter(
      (item) =>
        QUOTABLE_SOURCES.has(item.source) &&
        itemEngagementTotal(item) > 0 &&
        !seenUrls.has(item.url) &&
        !seenQuotes.has(item.title.trim().toLowerCase()) &&
        isRelevant(item),
    )
    .sort((a, b) => itemEngagementTotal(b) - itemEngagementTotal(a));
  for (const item of backfill) {
    if (takes.length >= MAX_BEST_TAKES) break;
    const key = item.title.trim().toLowerCase();
    if (key.length === 0 || seenQuotes.has(key)) continue;
    seenQuotes.add(key);
    const take: BestTake = {
      quote: item.title,
      source: item.source,
      engagement: itemEngagementTotal(item),
      url: item.url,
    };
    if (item.author !== undefined) take.author = item.author;
    takes.push(take);
  }
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
  // Drop low-value junk (bare handles, clone repos, zero-signal social posts)
  // BEFORE clustering so it never seeds a cluster or pads topK.
  const cleaned = qualityFilter(deduped);
  const clusters = clusterMerge(cleaned);
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
