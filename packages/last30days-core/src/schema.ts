import { type } from 'arktype';

export const SourceLabel = type(
  '"hn" | "github" | "polymarket" | "reddit" | "x" | "web" | "tiktok" | "instagram" | "threads" | "pinterest" | "youtube"'
);
export type SourceLabel = typeof SourceLabel.infer;

export const Engagement = type({
  upvotes: 'number',
  comments: 'number',
  'views?': 'number',
  'shares?': 'number',
});
export type Engagement = typeof Engagement.infer;

export const ResearchItem = type({
  url: 'string',
  title: 'string',
  publishedAt: 'string',
  source: SourceLabel,
  engagement: Engagement,
  'provenance?': '"standard" | "degraded"',
  'entityTag?': 'string',
  'author?': 'string',
});
export type ResearchItem = typeof ResearchItem.infer;

export const Citation = type({
  url: 'string',
  source: SourceLabel,
  retrievedAt: 'string',
  'title?': 'string',
});
export type Citation = typeof Citation.infer;

export const Report = type({
  topic: 'string',
  days: 'number',
  items: ResearchItem.array(),
  citations: Citation.array(),
  generatedAt: 'string',
});
export type Report = typeof Report.infer;
