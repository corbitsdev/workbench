/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { RedditOpportunityScan } from '../../components/RedditOpportunityBody';
import { RedditOpportunityReviewForm } from './RedditOpportunityReviewForm';

afterEach(() => {
  cleanup();
});

const scan: RedditOpportunityScan = {
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
    keywords: [
      { label: 'analytics', reason: 'core', confidence: 0.9, source: 'inferred' },
      { label: 'dashboards', reason: 'feature', confidence: 0.7, source: 'inferred' },
    ],
    subreddits: [
      { label: 'SaaS', reason: 'buyers', confidence: 0.8, source: 'inferred' },
      { label: 'startups', reason: 'founders', confidence: 0.6, source: 'inferred' },
    ],
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
};

describe('RedditOpportunityReviewForm', () => {
  it('accepts or rejects every recommendation in a section', () => {
    const onChange = mock((next: RedditOpportunityScan) => next);

    render(
      React.createElement(RedditOpportunityReviewForm, {
        scan,
        onChange,
      })
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Accept all' })[0]!);
    expect(onChange).toHaveBeenCalled();
    const acceptedCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    const acceptedKeywords = acceptedCall?.[0].recommendations.keywords;
    expect(
      acceptedKeywords?.every(
        (item: RedditOpportunityScan['recommendations']['keywords'][number]) =>
          item.source === 'accepted'
      )
    ).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Reject all' })[1]!);
    const rejectedCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    const rejectedSubreddits = rejectedCall?.[0].recommendations.subreddits;
    expect(
      rejectedSubreddits?.every(
        (item: RedditOpportunityScan['recommendations']['subreddits'][number]) =>
          item.source === 'rejected'
      )
    ).toBe(true);
  });
});
