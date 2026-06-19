import { CredentialRequirement, GrantRequirement } from '@intx/types';
import { canonicalizeToolNames } from '../tool-names';
import { FREDDIE_DEPLOY_PROMPT as FABLE_BASE_PROMPT } from '../freddie/prompt';
import { WORKBENCH_AGENT_GUIDANCE } from '../freddie/workbench-guidance';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
export const FANNIE_DEPLOY_PROMPT = FABLE_BASE_PROMPT + WORKBENCH_AGENT_GUIDANCE;

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const FANNIE_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: 'invoker', resource: 'tool:mail_search', action: 'invoke' },
  { source: 'invoker', resource: 'tool:mail_reply', action: 'invoke' },
];

export const FANNIE_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'anthropic',
    source: 'tenant',
    name: 'anthropic-api',
  },
];

export const FANNIE_MODEL_CONFIG = {
  defaultModel: 'claude-sonnet-4-6',
} as const;

export const FANNIE_CREDENTIAL_PROVIDER_NAMES = [
  'firecrawl',
  'granola',
  'github',
  'scrapecreators',
  'bluesky',
] as const;

export const FANNIE_CAPABILITIES = {
  tools: canonicalizeToolNames([
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
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'run_shell',
    'grep',
    'write_artifact',
    'artifact_create',
    'mail_search',
    'mail_reply',
    'bluesky_search',
    'scrapecreators_tiktok',
    'scrapecreators_instagram',
    'scrapecreators_threads',
    'scrapecreators_pinterest',
  ]),
} as const;

export const FANNIE_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Fannie',
  name: 'Fannie',
  modelConfig: FANNIE_MODEL_CONFIG,
  systemPrompt: FANNIE_DEPLOY_PROMPT,
  credentialProviderNames: [...FANNIE_CREDENTIAL_PROVIDER_NAMES],
  defaultTools: [...FANNIE_CAPABILITIES.tools],
  requiredTools: [...FANNIE_CAPABILITIES.tools],
};
