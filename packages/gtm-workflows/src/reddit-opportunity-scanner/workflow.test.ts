import { describe, expect, it } from 'bun:test';
import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import { type } from 'arktype';
import { workflowRegistry, flattenStepCredentialRequirements } from '@workbench/workflow-core';
import {
  redditOpportunityScannerWorkflow as fromRoot,
  redditOpportunityScanArtifactSchema,
} from '../index';
import { redditOpportunityScannerWorkflow as fromModule } from './workflow';

describe('reddit opportunity scanner workflow', () => {
  it('is exported from the package root', () => {
    expect(fromRoot).toBe(fromModule);
  });

  it('registers and exposes the workflow definition by kind', () => {
    workflowRegistry.register(fromModule);
    expect(workflowRegistry.get('reddit-opportunity-scanner')).toBe(fromModule);
    expect(workflowRegistry.isValid('reddit-opportunity-scanner')).toBe(true);
  });

  it('declares the shared inference credential once across analysis and guided scan steps', () => {
    const flat = flattenStepCredentialRequirements(fromModule);
    expect(flat).toEqual([
      {
        providerName: 'openai-compatible',
        source: 'tenant',
        name: LLM_CREDENTIAL_NAME,
        defaultModel: LLM_DEFAULT_MODEL,
      },
    ]);
    expect(fromModule.steps.find((step) => step.name === 'scan')?.credentialRequirements).toEqual([
      {
        providerName: 'openai-compatible',
        source: 'tenant',
        name: LLM_CREDENTIAL_NAME,
        defaultModel: LLM_DEFAULT_MODEL,
      },
    ]);
  });

  it('maps lifecycle statuses to the expected human-in-the-loop steps', () => {
    expect(fromModule.deriveCurrentStep?.('pending')).toBe('intake');
    expect(fromModule.deriveCurrentStep?.('analyzing')).toBe('analyze');
    expect(fromModule.deriveCurrentStep?.('reviewing')).toBe('review');
    expect(fromModule.deriveCurrentStep?.('done')).toBe('scan');
  });

  it('describes the durable reddit opportunity artifact contract with ArkType', () => {
    const parsed = redditOpportunityScanArtifactSchema({
      artifactType: 'reddit-opportunity-scan',
      title: 'Reddit opportunities',
      summary: 'Two threads are worth reviewing.',
      inputUrl: 'https://example.com',
      businessProfile: {
        whatTheySell: 'Analytics software',
        mainKeywords: ['analytics'],
        competitors: ['Mixpanel'],
        evidence: ['Homepage'],
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
    });
    expect(parsed).not.toBeInstanceOf(type.errors);
  });
});
