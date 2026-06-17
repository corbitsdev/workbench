import { describe, expect, it } from 'bun:test';
import { rankOpportunities, scoreOpportunity } from './scoring';
import type { NormalizedRedditPost } from './types';
import type { RedditOpportunityScanArtifact } from './schema';

const context: RedditOpportunityScanArtifact = {
  artifactType: 'reddit-opportunity-scan',
  title: 'Test',
  summary: 'Test',
  inputUrl: 'https://example.com',
  businessProfile: {
    whatTheySell: 'Analytics',
    mainKeywords: ['analytics'],
    competitors: ['Mixpanel'],
    evidence: [],
  },
  recommendations: {
    keywords: [{ label: 'analytics', reason: 'core', confidence: 0.9, source: 'accepted' }],
    subreddits: [{ label: 'SaaS', reason: 'buyers', confidence: 0.8, source: 'accepted' }],
  },
  scanConfig: {
    timeWindow: '30d',
    matchMode: 'keyword-and-competitor',
    scope: 'posts-and-comments',
    threshold: 50,
    resultCap: 10,
  },
  opportunities: [],
  watchlist: { keywords: [], subreddits: [], competitors: [], lastScannedAt: '' },
  exports: { channelBrief: '', responsePlaybook: '', opportunityFeed: '' },
};

const post: NormalizedRedditPost = {
  url: 'https://reddit.com/r/SaaS/comments/abc',
  title: 'Looking for analytics advice',
  publishedAt: new Date().toISOString(),
  source: 'reddit',
  engagement: { upvotes: 42, comments: 12 },
  author: 'r/SaaS',
  topComments: ['What are people using for analytics?'],
};

describe('reddit opportunity scoring', () => {
  it('scores a matching post above the threshold', () => {
    const scored = scoreOpportunity(post, context, ['analytics']);
    expect(scored.score).toBeGreaterThanOrEqual(50);
    expect(scored.subreddit).toBe('SaaS');
    expect(scored.matchedTerms).toEqual(['analytics']);
  });

  it('ranks and caps opportunities', () => {
    const ranked = rankOpportunities([{ post, matchedTerms: ['analytics'] }], context);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.status).toBe('new');
  });
});
