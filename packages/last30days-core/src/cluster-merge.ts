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

// First-pass title-similarity threshold. The reference engine clusters around
// high-ranked leaders at a prepared-text similarity of ~0.48 (cluster.py); a
// full-title Jaccard at 0.5 is the comparable bar. The previous 0.8 was so high
// that near-identical headlines about the same story stayed split — the root of
// the "one item per cluster" flat brief. Lower it so genuine restatements of the
// same story merge, while the second entity-overlap pass catches different-words
// coverage of the same entity.
const TITLE_SIM_THRESHOLD = 0.5;

// Second-pass entity-overlap threshold (overlap coefficient), ported from the
// reference's entity-merge pass (overlap >= 0.45 on significant words). Catches
// the same-entity-different-words case the title Jaccard misses (e.g. "Cursor
// 2.0 ships agent mode" vs "Hands-on with Cursor's new agent mode").
const ENTITY_OVERLAP_THRESHOLD = 0.45;

// A cluster must carry at least this many distinct significant tokens to take
// part in the entity-overlap merge. Stops two single-keyword clusters from
// fusing on one shared generic word (the over-merge failure mode): real themes
// accumulate several shared named entities, noise shares one.
const MIN_ENTITY_TOKENS = 2;

// Generic content words that carry no entity signal. Excluded from the
// significant-token set so coverage of two unrelated stories that both happen to
// say "post"/"story"/"update" does not merge on that alone. Mirrors the
// reference's stopword filtering before entity overlap.
const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "announced",
  "announces",
  "because",
  "been",
  "before",
  "being",
  "best",
  "could",
  "discussion",
  "does",
  "from",
  "have",
  "here",
  "into",
  "just",
  "like",
  "more",
  "most",
  "much",
  "need",
  "news",
  "over",
  "post",
  "posts",
  "released",
  "report",
  "should",
  "some",
  "story",
  "such",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "thread",
  "threads",
  "this",
  "update",
  "updates",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
]);

// A token is "significant" (an entity-like word) when it survives stopword
// filtering and is either long enough to be a name or carries a digit (a
// version/number, e.g. "gpt5", "v2"). Mirrors the reference's "capitalized, ALL
// CAPS, contain digits, or 4+ chars" rule, lowercased.
function isSignificant(token: string): boolean {
  if (STOPWORDS.has(token)) return false;
  return token.length >= 4 || /[0-9]/.test(token);
}

function significantTokens(cluster: Cluster): Set<string> {
  const tokens = new Set<string>();
  for (const item of cluster.items) {
    for (const token of normalizeTokens(item.title)) {
      if (isSignificant(token)) tokens.add(token);
    }
  }
  return tokens;
}

// Overlap coefficient: |A ∩ B| / min(|A|, |B|). Rewards a small focused cluster
// fully contained in a larger one (the same entity covered at two depths).
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) shared += 1;
  }
  const min = Math.min(a.size, b.size);
  return min === 0 ? 0 : shared / min;
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
    if (jaccardSimilarity(itemTokens, topTokens) >= TITLE_SIM_THRESHOLD) {
      return cluster;
    }
  }

  return undefined;
}

function mergeInto(target: Cluster, source: Cluster): void {
  for (const item of source.items) target.items.push(item);
  for (const s of source.sources) target.sources.add(s);
}

// Second pass: fuse first-pass clusters that cover the same entity with
// different words. Greedy union over the precomputed significant-token sets:
// each later cluster folds into the first earlier cluster it overlaps, so a
// theme accretes around its first-seen leader. Deterministic — driven by the
// stable leader order the first pass produced.
function entityMerge(clusters: Cluster[]): Cluster[] {
  const tokenSets = clusters.map(significantTokens);
  const absorbedBy = new Array<number>(clusters.length).fill(-1);

  for (let i = 0; i < clusters.length; i++) {
    if (absorbedBy[i] !== -1) continue;
    const setI = tokenSets[i];
    if (setI === undefined || setI.size < MIN_ENTITY_TOKENS) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      if (absorbedBy[j] !== -1) continue;
      const setJ = tokenSets[j];
      if (setJ === undefined || setJ.size < MIN_ENTITY_TOKENS) continue;
      if (overlapCoefficient(setI, setJ) >= ENTITY_OVERLAP_THRESHOLD) {
        const leader = clusters[i];
        const folded = clusters[j];
        if (leader === undefined || folded === undefined) continue;
        mergeInto(leader, folded);
        for (const token of setJ) setI.add(token);
        absorbedBy[j] = i;
      }
    }
  }

  return clusters.filter((_, index) => absorbedBy[index] === -1);
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

  return entityMerge(clusters);
}
