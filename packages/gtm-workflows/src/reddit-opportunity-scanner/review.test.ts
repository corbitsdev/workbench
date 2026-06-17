import { describe, expect, it } from 'bun:test';
import { mergeRedditScanReview, updateOpportunityStatus } from './review';

const baseContent = JSON.stringify({
  artifactType: 'reddit-opportunity-scan',
  title: 'Reddit opportunities',
  summary: 'Review before scan',
  inputUrl: 'https://example.com',
  businessProfile: {
    whatTheySell: 'Analytics',
    mainKeywords: ['analytics'],
    competitors: [],
    evidence: [],
  },
  recommendations: {
    keywords: [{ label: 'analytics', reason: 'core', confidence: 0.9, source: 'inferred' }],
    subreddits: [{ label: 'SaaS', reason: 'buyers', confidence: 0.8, source: 'inferred' }],
  },
  scanConfig: {
    timeWindow: '30d',
    matchMode: 'keyword-and-competitor',
    scope: 'posts-and-comments',
    threshold: 70,
    resultCap: 25,
  },
  opportunities: [],
  watchlist: { keywords: [], subreddits: [], competitors: [], lastScannedAt: '' },
  exports: { channelBrief: '', responsePlaybook: '', opportunityFeed: '' },
});

describe('reddit opportunity review', () => {
  it('merges recommendation and scan config edits', () => {
    const merged = JSON.parse(
      mergeRedditScanReview(baseContent, {
        recommendations: {
          keywords: [{ label: 'devtools', reason: 'added', confidence: 1, source: 'user-added' }],
          subreddits: [{ label: 'SaaS', reason: 'buyers', confidence: 0.8, source: 'accepted' }],
        },
        scanConfig: {
          timeWindow: '7d',
          matchMode: 'keyword',
          scope: 'posts-and-comments',
          threshold: 60,
          resultCap: 10,
        },
      })
    );
    expect(merged.recommendations.keywords[0].label).toBe('devtools');
    expect(merged.scanConfig.timeWindow).toBe('7d');
  });

  it('updates opportunity status in place', () => {
    const withOpp = JSON.parse(baseContent);
    withOpp.opportunities = [
      {
        id: 'opp-1',
        subreddit: 'SaaS',
        postTitle: 'Need help',
        postUrl: 'https://reddit.com/1',
        permalink: 'https://reddit.com/1',
        matchedTerms: ['analytics'],
        evidenceSnippet: 'snippet',
        score: 80,
        signalBreakdown: {},
        recommendedAction: 'Reply',
        status: 'new',
      },
    ];
    const updated = JSON.parse(
      updateOpportunityStatus(JSON.stringify(withOpp), 'opp-1', 'saved')
    );
    expect(updated.opportunities[0].status).toBe('saved');
  });
});