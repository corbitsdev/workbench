import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const intakeAgent = defineAgent({
  id: 'reddit-opportunity-intake',
  description: 'Collects the website URL and optional brand or ICP hints.',
  systemPrompt:
    'You are a scan intake agent. Collect the website URL and any optional brand name, target geography, or ICP hints.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

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
export const kind = 'reddit-opportunity-scanner';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: step({ agent: intakeAgent }),
    analyze: step({ agent: analyzeAgent, after: ['intake'] }),
    review: awaitSignal({ name: 'recommendation-review', after: ['analyze'] }),
    scan: step({ agent: scanAgent, after: ['review'] }),
  },
});
