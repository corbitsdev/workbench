import { CredentialRequirement, GrantRequirement } from '@intx/types';
import { FOPUS_DEPLOY_PROMPT } from './prompt';
export { FOPUS_DEPLOY_PROMPT } from './prompt';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const FOPUS_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: 'invoker', resource: 'tool:mail_search', action: 'invoke' },
  { source: 'invoker', resource: 'tool:mail_reply', action: 'invoke' },
];

export const FOPUS_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'anthropic',
    source: 'tenant',
    name: 'Anthropic',
  },
];

export const FOPUS_MODEL_CONFIG = {
  defaultModel: 'claude-opus-4-8',
} as const;

export const FOPUS_CREDENTIAL_PROVIDER_NAMES = [
  'firecrawl',
  'granola',
  'xai',
  'reddit',
  'exa',
  'github',
  'scrapecreators',
  'youtube',
  'bluesky',
] as const;

export const FOPUS_CAPABILITIES = {
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
    'granola_search',
    'hackernews_search',
    'github_activity',
    'polymarket_odds',
    'exa_search',
    'web_search',
    'last30days_core_extract',
    'last30days_core_report',
    'last30days_validate',
    'write_artifact',
    'reddit_search',
    'reddit_subreddit_search',
    'x_search',
    'youtube_search',
    'bluesky_search',
    'scrapecreators_tiktok',
    'scrapecreators_instagram',
    'scrapecreators_threads',
    'scrapecreators_pinterest',
    'mail_search',
    'mail_reply',
  ],
} as const;

