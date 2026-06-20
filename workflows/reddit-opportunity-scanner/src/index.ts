import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const analyzeAgent = defineAgent({
  id: 'reddit-opportunity-analyze',
  description: 'Scrapes the site and infers what the business sells, its keywords, and audience.',
  systemPrompt:
    'You are a business analysis agent. Scrape the site content and infer what the business sells, its keywords, competitors, and audience signals.',
  tools: [],
  capabilities: canonicalizeToolNames(['firecrawl_scrape']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const scanAgent = defineAgent({
  id: 'reddit-opportunity-scan',
  description: 'Searches Reddit for approved keywords and subreddits, then ranks opportunities.',
  systemPrompt:
    'You are a Reddit scanning agent. Search Reddit for the approved keywords and subreddits, then score the best opportunities.',
  tools: [],
  capabilities: canonicalizeToolNames(['reddit_search', 'reddit_subreddit_search']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'Reddit Opportunity Scanner';
export const description = 'Scan subreddits for buying signals, pain points, and competitor mentions.';
export const kind = 'reddit-opportunity-scanner';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: awaitSignal({ name: 'intake' }),
    analyze: step({
      agent: analyzeAgent,
      input: { from: 'steps.intake.output' },
      after: ['intake'],
    }),
    review: awaitSignal({ name: 'recommendation-review', after: ['analyze'] }),
    scan: step({
      agent: scanAgent,
      input: { from: 'steps.analyze.output' },
      after: ['review'],
    }),
  },
});
