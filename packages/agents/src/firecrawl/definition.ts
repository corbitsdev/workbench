import type { GrantRequirement, CredentialRequirement } from '@intx/types';
import { buildFirecrawlSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const FIRECRAWL_GRANT_REQUIREMENTS: GrantRequirementType[] = [];

export const FIRECRAWL_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'firecrawl',
    source: 'tenant',
  },
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
];

export const FIRECRAWL_DEPLOY_PROMPT: string = buildFirecrawlSystemPrompt('Freddy', { xml: true });

export const FIRECRAWL_CAPABILITIES = {
  tools: [
    'firecrawl_scrape',
    'firecrawl_search',
    'firecrawl_map',
    'firecrawl_crawl_start',
    'firecrawl_crawl_status',
    'firecrawl_batch_scrape_start',
    'firecrawl_batch_scrape_status',
    'firecrawl_extract_start',
    'firecrawl_extract_status',
    'firecrawl_agent',
    'firecrawl_parse',
    'firecrawl_credit_usage',
    'firecrawl_token_usage',
  ],
  schedulerIntervalMs: 60_000,
} as const;

export const FIRECRAWL_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Freddy — Web Intelligence',
  name: 'Freddy',
  systemPrompt: FIRECRAWL_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible', 'firecrawl'],
  defaultTools: [...FIRECRAWL_CAPABILITIES.tools],
  requiredTools: [...FIRECRAWL_CAPABILITIES.tools],
};
