import { type } from 'arktype';

export const REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND = 'reddit-opportunity-scan';

export const redditOpportunityRecommendationSchema = type({
  label: 'string',
  reason: 'string',
  confidence: 'number',
  source: "'inferred'|'user-added'|'edited'|'accepted'|'rejected'",
});

export const redditOpportunitySchema = type({
  id: 'string',
  subreddit: 'string',
  postTitle: 'string',
  postUrl: 'string',
  permalink: 'string',
  matchedTerms: 'string[]',
  evidenceSnippet: 'string',
  score: 'number',
  signalBreakdown: 'object',
  recommendedAction: 'string',
  status: 'string',
});

export const redditOpportunityScanArtifactSchema = type({
  artifactType: `'${REDDIT_OPPORTUNITY_SCAN_ARTIFACT_KIND}'`,
  title: 'string',
  summary: 'string',
  inputUrl: 'string',
  'brandName?': 'string',
  'targetGeography?': 'string',
  'icpHints?': 'string',
  businessProfile: {
    whatTheySell: 'string',
    mainKeywords: 'string[]',
    competitors: 'string[]',
    'audienceNotes?': 'string',
    evidence: 'string[]',
  },
  recommendations: {
    keywords: redditOpportunityRecommendationSchema.array(),
    subreddits: redditOpportunityRecommendationSchema.array(),
  },
  scanConfig: {
    timeWindow: 'string',
    matchMode: 'string',
    scope: 'string',
    threshold: 'number',
    resultCap: 'number',
  },
  opportunities: redditOpportunitySchema.array(),
  watchlist: {
    keywords: 'string[]',
    subreddits: 'string[]',
    competitors: 'string[]',
    lastScannedAt: 'string',
  },
  exports: {
    channelBrief: 'string',
    responsePlaybook: 'string',
    opportunityFeed: 'string',
  },
});

export type RedditOpportunityScanArtifact = typeof redditOpportunityScanArtifactSchema.infer;

export function parseRedditOpportunityScanArtifact(
  value: unknown
): RedditOpportunityScanArtifact | null {
  const parsed = redditOpportunityScanArtifactSchema(value);
  if (parsed instanceof type.errors) return null;
  return parsed;
}
