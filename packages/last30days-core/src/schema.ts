import { type } from "arktype";

export const SourceLabel = type(
  '"hn" | "github" | "polymarket" | "reddit" | "x" | "web" | "tiktok" | "instagram" | "threads" | "pinterest" | "youtube" | "bluesky"',
);
export type SourceLabel = typeof SourceLabel.infer;

export const Engagement = type({
  upvotes: "number",
  comments: "number",
  "views?": "number",
  "shares?": "number",
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
  generatedAt: "string",
});
export type Report = typeof Report.infer;

/**
 * Validate an unknown value (e.g. a persisted artifact's source.brief) against
 * the Report contract. Returns the validated brief or null — the single parse
 * helper consumers should use instead of re-declaring the schema at each boundary.
 */
export function parseReport(value: unknown): Report | null {
  const result = Report(value);
  return result instanceof type.errors ? null : result;
}
