/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import ResearchBody from './ResearchBody';
import ArtifactBody from './ArtifactBody';
import type { ResearchBrief } from './ResearchBody';

afterEach(() => {
  cleanup();
});

const FIXTURE_BRIEF: ResearchBrief = {
  topic: 'AI Infrastructure Trends',
  days: 30,
  queryType: 'NEWS',
  stats: {
    sourceCount: 12,
    itemCount: 47,
    dateRange: { from: '2026-05-15', to: '2026-06-15' },
  },
  leadInsight: 'GPU supply constraints are easing as new fabs come online.',
  clusters: [
    {
      id: 'cluster-1',
      title: 'Model Serving Cost Reduction',
      score: 8.4,
      sources: ['hn', 'reddit'],
      items: [
        {
          url: 'https://example.com/story-1',
          title: 'vLLM 0.5 cuts inference cost by 40%',
          publishedAt: '2026-06-01',
          source: 'hn',
          engagement: { upvotes: 1200, comments: 87 },
        },
        {
          url: 'https://example.com/story-2',
          title: 'Speculative decoding lands in production',
          publishedAt: '2026-06-02',
          source: 'reddit',
          engagement: { upvotes: 340, comments: 22 },
        },
      ],
      summary: 'New serving optimizations make LLM deployment 40% cheaper.',
    },
    {
      id: 'cluster-2',
      title: 'GPU Supply Chain Updates',
      score: 7.1,
      sources: ['web'],
      items: [
        {
          url: 'https://example.com/story-3',
          title: 'TSMC expands capacity for AI chip orders',
          publishedAt: '2026-06-05',
          source: 'web',
          engagement: { upvotes: 890, comments: 54 },
        },
      ],
    },
  ],
  bestTakes: [
    {
      quote: 'Inference is the new training — the bottleneck has shifted.',
      author: 'Jane Doe',
      source: 'hn',
      engagement: 1450,
      url: 'https://example.com/comment-1',
    },
    {
      quote: 'We are finally seeing commoditization at the infrastructure layer.',
      source: 'reddit',
      engagement: 320,
      url: 'https://example.com/comment-2',
    },
  ],
  items: [],
  citations: [
    {
      url: 'https://example.com/story-1',
      source: 'hn',
      retrievedAt: '2026-06-15',
      title: 'vLLM 0.5 cuts inference cost by 40%',
    },
    {
      url: 'https://example.com/story-3',
      source: 'web',
      retrievedAt: '2026-06-15',
    },
  ],
  generatedAt: '2026-06-15T12:00:00Z',
};

describe('ResearchBody', () => {
  it('renders the topic heading', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText('AI Infrastructure Trends');
  });

  it('renders the stats line with source count, item count, and date range', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText(/12 sources · 47 items · 2026-05-15–2026-06-15/);
  });

  it('renders the lead insight', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText('GPU supply constraints are easing as new fabs come online.');
  });

  it('renders cluster titles', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText('Model Serving Cost Reduction');
    screen.getByText('GPU Supply Chain Updates');
  });

  it('renders cluster item links with titles', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    const link = screen.getByText('vLLM 0.5 cuts inference cost by 40%');
    const anchor = link.closest('a');
    if (!anchor) throw new Error('Expected item title to be wrapped in an anchor');
    if (anchor.getAttribute('href') !== 'https://example.com/story-1') {
      throw new Error('Item link href does not match expected URL');
    }
  });

  it('renders cluster item engagement counts', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText(/1200 up · 87 comments/);
  });

  it('renders best takes with quote text', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText('Inference is the new training — the bottleneck has shifted.');
    screen.getByText('We are finally seeing commoditization at the infrastructure layer.');
  });

  it('renders best take attribution', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText(/Jane Doe · hn/);
  });

  it('renders best take engagement count', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    screen.getByText(/1450 engagement/);
  });

  it('renders citations list with titles and source links', () => {
    render(React.createElement(ResearchBody, { brief: FIXTURE_BRIEF }));
    const citationTitles = screen.getAllByText('vLLM 0.5 cuts inference cost by 40%');
    if (citationTitles.length === 0) throw new Error('Expected citation title to appear');
    const citationLinks = screen.getAllByRole('link', { name: 'web' });
    if (citationLinks.length === 0) throw new Error('Expected citation source link to appear');
  });

  it('skips best takes block when list is empty', () => {
    const briefWithoutTakes: ResearchBrief = { ...FIXTURE_BRIEF, bestTakes: [] };
    render(React.createElement(ResearchBody, { brief: briefWithoutTakes }));
    const heading = screen.queryByText('Best Takes');
    if (heading !== null)
      throw new Error('Expected Best Takes heading to be absent when list is empty');
  });
});

describe('ArtifactBody research routing', () => {
  it('renders ResearchBody when kind is research and brief is valid', () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          content: '# Fallback markdown',
          kind: 'research',
          source: { brief: FIXTURE_BRIEF },
        },
      })
    );
    screen.getByText('AI Infrastructure Trends');
    screen.getByText(/12 sources · 47 items/);
  });

  it('falls back to markdown when kind is research but brief is absent', () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: { content: '# Fallback heading', kind: 'research' },
      })
    );
    screen.getByText('Fallback heading');
  });

  it('falls back to markdown when kind is research but brief is malformed', () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          content: '# Fallback heading',
          kind: 'research',
          source: { brief: { topic: 123, clusters: 'not-an-array' } },
        },
      })
    );
    screen.getByText('Fallback heading');
  });

  it('falls back to markdown when kind is research and brief is null', () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: { content: '# Fallback heading', kind: 'research', source: null },
      })
    );
    screen.getByText('Fallback heading');
  });
});
