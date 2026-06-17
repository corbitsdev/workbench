import { type } from 'arktype';
import {
  parseRedditOpportunityScanArtifact,
  redditOpportunityRecommendationSchema,
  redditOpportunityScanArtifactSchema,
  type RedditOpportunityScanArtifact,
} from './schema';

const reviewPatchSchema = type({
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
});

export function mergeRedditScanReview(currentContent: string, patch: unknown): string {
  const current = parseRedditOpportunityScanArtifact(JSON.parse(currentContent));
  if (!current) throw new Error('Invalid reddit opportunity artifact');

  const parsedPatch = reviewPatchSchema(patch);
  if (parsedPatch instanceof type.errors) {
    throw new Error(`Invalid review patch: ${parsedPatch.summary}`);
  }

  const next: RedditOpportunityScanArtifact = {
    ...current,
    recommendations: parsedPatch.recommendations,
    scanConfig: parsedPatch.scanConfig,
  };

  const validated = redditOpportunityScanArtifactSchema(next);
  if (validated instanceof type.errors) {
    throw new Error(`Merged artifact invalid: ${validated.summary}`);
  }

  return JSON.stringify(validated);
}

export function updateOpportunityStatus(
  currentContent: string,
  opportunityId: string,
  status: string
): string {
  const current = parseRedditOpportunityScanArtifact(JSON.parse(currentContent));
  if (!current) throw new Error('Invalid reddit opportunity artifact');

  const next: RedditOpportunityScanArtifact = {
    ...current,
    opportunities: current.opportunities.map((opp) =>
      opp.id === opportunityId ? { ...opp, status } : opp
    ),
  };

  const validated = redditOpportunityScanArtifactSchema(next);
  if (validated instanceof type.errors) {
    throw new Error(`Updated artifact invalid: ${validated.summary}`);
  }

  return JSON.stringify(validated);
}
