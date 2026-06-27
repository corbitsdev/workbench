import { type } from "arktype";

export const SourceLabel = type(
  '"hn" | "github" | "polymarket" | "reddit" | "x" | "web" | "tiktok" | "instagram" | "threads" | "pinterest" | "youtube" | "bluesky"',
);
export type SourceLabel = typeof SourceLabel.infer;

export const Engagement = type({
  // Vote-style fields are optional: a source like GitHub has stars but no
  // upvotes/comments, and emitting a misleading zero would read as "a post with
  // no reactions". Omit what does not apply.
  "upvotes?": "number",
  "comments?": "number",
  "views?": "number",
  "shares?": "number",
  // GitHub stars are NOT upvotes — they are a distinct unit and must not inflate
  // the upvote-based engagement signal. The writer labels them as "stars".
  "stars?": "number",
});
export type Engagement = typeof Engagement.infer;

export const TopComment = type({
  text: "string",
  "author?": "string",
  score: "number",
});
export type TopComment = typeof TopComment.infer;

export const ResearchItem = type({
  url: "string",
  title: "string",
  publishedAt: "string",
  source: SourceLabel,
  "engagement?": Engagement,
  "provenance?": '"standard" | "degraded"',
  "entityTag?": "string",
  "author?": "string",
  "topComments?": TopComment.array(),
  // Topic-relevance score in [0, 100]. Populated by the LLM rerank step when
  // present; otherwise the ranker computes a deterministic local relevance via
  // entity grounding. Mirrors the reference engine's `rerank_score`.
  "relevance?": "number",
});
export type ResearchItem = typeof ResearchItem.infer;

export const Citation = type({
  url: "string",
  source: SourceLabel,
  retrievedAt: "string",
  "title?": "string",
});
export type Citation = typeof Citation.infer;

export const QueryType = type(
  '"GENERAL" | "NEWS" | "COMPARISON" | "RECOMMENDATIONS"',
);
export type QueryType = typeof QueryType.infer;

export const DateRange = type({
  from: "string",
  to: "string",
});
export type DateRange = typeof DateRange.infer;

export const ReportStats = type({
  sourceCount: "number",
  itemCount: "number",
  "dateRange?": DateRange,
});
export type ReportStats = typeof ReportStats.infer;

export const BriefCluster = type({
  id: "string",
  title: "string",
  score: "number",
  sources: SourceLabel.array(),
  items: ResearchItem.array(),
  "summary?": "string",
});
export type BriefCluster = typeof BriefCluster.infer;

export const BestTake = type({
  quote: "string",
  "author?": "string",
  source: SourceLabel,
  engagement: "number",
  url: "string",
});
export type BestTake = typeof BestTake.infer;

export const SkippedSource = type({
  source: "string",
  kind: '"source-error" | "invalid-items"',
  reason: "string",
});
export type SkippedSource = typeof SkippedSource.infer;

export const Report = type({
  topic: "string",
  days: "number",
  "queryType?": QueryType,
  stats: ReportStats,
  "leadInsight?": "string",
  clusters: BriefCluster.array(),
  bestTakes: BestTake.array(),
  items: ResearchItem.array(),
  citations: Citation.array(),
  "skippedSources?": SkippedSource.array(),
  generatedAt: "string",
});
export type Report = typeof Report.infer;

// The LLM curate step's structured output (CL-2503): the judgment the
// deterministic cluster/filter pipeline cannot do — junk dropped, survivors
// grouped into a few named themes, and verbatim community quotes selected with
// attribution + engagement. The brief tool parses the curate reply through this
// schema and assembles a Report from it (falling back to the deterministic
// buildReport when the reply is missing or yields no usable theme).
export const CuratedTheme = type({
  title: "string",
  "summary?": "string",
  // URLs of the collected items this theme is built from. The brief resolves
  // them back to full ResearchItems; unknown urls are dropped.
  itemUrls: "string[]",
});
export type CuratedTheme = typeof CuratedTheme.infer;

export const CuratedQuote = type({
  quote: "string",
  "author?": "string",
  source: SourceLabel,
  engagement: "number",
  url: "string",
});
export type CuratedQuote = typeof CuratedQuote.infer;

export const Curation = type({
  themes: CuratedTheme.array(),
  quotes: CuratedQuote.array(),
});
export type Curation = typeof Curation.infer;

/**
 * Validate an unknown value against the Curation contract. Returns the
 * validated curation or null so the brief boundary can fall back to the
 * deterministic pipeline on a malformed curate reply.
 */
export function parseCuration(value: unknown): Curation | null {
  const result = Curation(value);
  return result instanceof type.errors ? null : result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient curation parse for the brief boundary. The curate model is a stochastic
 * JSON producer — one malformed quote (engagement as a string, a missing url) or a
 * stray theme must NOT discard the whole reply and force the junky deterministic
 * fallback. So validate each theme and quote INDIVIDUALLY against its schema, drop
 * only the invalid ones (coercing a numeric-string engagement), and return the
 * salvaged Curation. Returns null only when no usable theme survives — the genuine
 * fall-back-to-deterministic case.
 */
export function coerceCuration(value: unknown): Curation | null {
  if (!isPlainObject(value)) return null;
  const rawThemes = Array.isArray(value.themes) ? value.themes : [];
  const rawQuotes = Array.isArray(value.quotes) ? value.quotes : [];

  const themes: CuratedTheme[] = [];
  for (const candidate of rawThemes) {
    const validated = CuratedTheme(candidate);
    if (!(validated instanceof type.errors)) themes.push(validated);
  }
  if (themes.length === 0) return null;

  const quotes: CuratedQuote[] = [];
  for (const candidate of rawQuotes) {
    const normalized = isPlainObject(candidate)
      ? { ...candidate, engagement: coerceNumber(candidate.engagement) }
      : candidate;
    const validated = CuratedQuote(normalized);
    if (!(validated instanceof type.errors)) quotes.push(validated);
  }
  return { themes, quotes };
}

function coerceNumber(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,_\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/**
 * Validate an unknown value (e.g. a persisted artifact's source.brief) against
 * the Report contract. Returns the validated brief or null — the single parse
 * helper consumers should use instead of re-declaring the schema at each boundary.
 */
export function parseReport(value: unknown): Report | null {
  const result = Report(value);
  return result instanceof type.errors ? null : result;
}
