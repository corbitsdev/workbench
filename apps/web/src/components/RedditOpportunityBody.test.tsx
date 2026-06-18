/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import RedditOpportunityBody, {
  parseRedditOpportunityScan,
  type RedditOpportunityScan,
} from './RedditOpportunityBody';

afterEach(() => {
  cleanup();
});

const validScan: RedditOpportunityScan = {
  artifactType: 'reddit-opportunity-scan',
  title: 'Reddit opportunities for Acme',
  summary: 'Three conversations are worth engaging.',
  inputUrl: 'https://example.com',
  businessProfile: {
    whatTheySell: 'Analytics software',
    mainKeywords: ['analytics'],
    competitors: ['Mixpanel'],
    evidence: ['Homepage hero'],
  },
  recommendations: {
    keywords: [{ label: 'analytics', reason: 'Core product', confidence: 0.9, source: 'accepted' }],
    subreddits: [{ label: 'SaaS', reason: 'Buyer community', confidence: 0.8, source: 'accepted' }],
  },
  scanConfig: {
    timeWindow: '30d',
    matchMode: 'semantic',
    scope: 'posts-and-comments',
    threshold: 70,
    resultCap: 25,
  },
  opportunities: [
    {
      id: 'opp-1',
      subreddit: 'SaaS',
      postTitle: 'Need analytics advice',
      postUrl: 'https://reddit.com/r/SaaS/comments/1',
      permalink: 'https://reddit.com/r/SaaS/comments/1',
      matchedTerms: ['analytics'],
      evidenceSnippet: 'What are people using for analytics?',
      score: 88,
      signalBreakdown: { intent: 40 },
      recommendedAction: 'Offer a benchmark checklist.',
      status: 'new',
    },
  ],
  watchlist: {
    keywords: ['analytics'],
    subreddits: ['SaaS'],
    competitors: ['Mixpanel'],
    lastScannedAt: '2026-06-17T00:00:00.000Z',
  },
  exports: {
    channelBrief: 'Brief',
    responsePlaybook: 'Playbook',
    opportunityFeed: 'Feed',
  },
};

describe('parseRedditOpportunityScan', () => {
  it('accepts the durable reddit opportunity scan artifact shape', () => {
    expect(parseRedditOpportunityScan(validScan)).toEqual(validScan);
  });

  it('accepts JSON-serialized artifact content from persistence', () => {
    expect(parseRedditOpportunityScan(JSON.stringify(validScan))).toEqual(validScan);
  });

  it('rejects incomplete scan artifacts', () => {
    expect(parseRedditOpportunityScan({ ...validScan, opportunities: 'not-list' })).toBeNull();
    expect(parseRedditOpportunityScan({ ...validScan, artifactType: 'research' })).toBeNull();
  });
});

describe('RedditOpportunityBody', () => {
  it('explains an empty results scan in results mode', () => {
    render(
      React.createElement(RedditOpportunityBody, {
        scan: {
          ...validScan,
          opportunities: [],
          summary: 'Found 0 Reddit opportunities for https://example.com.',
        },
        mode: 'results',
      })
    );

    expect(screen.getByText(/Found 0 ranked opportunities/i)).not.toBeNull();
    expect(screen.getByText(/No posts matched your approved keywords/i)).not.toBeNull();
  });
});
