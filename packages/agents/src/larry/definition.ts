import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import { buildLarrySystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const LARRY_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: 'invoker', resource: 'tool:mail_search', action: 'invoke' },
  { source: 'invoker', resource: 'tool:mail_reply', action: 'invoke' },
];

export const LARRY_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

export const LARRY_DEPLOY_PROMPT: string = buildLarrySystemPrompt('Larry');

export const LARRY_CAPABILITIES = {
  tools: [
    'hackernews_search',
    'github_activity',
    'polymarket_odds',
    'exa_search',
    'last30days_core_extract',
    'last30days_core_report',
    'last30days_validate',
    'write_artifact',
    'reddit_search',
    'reddit_subreddit_search',
    'x_search',
    'scrapecreators_tiktok',
    'scrapecreators_instagram',
    'scrapecreators_threads',
    'scrapecreators_pinterest',
    'mail_search',
    'mail_reply',
  ],
} as const;

export const LARRY_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Larry — last30days Research',
  name: 'Larry',
  systemPrompt: LARRY_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible', 'xai', 'github', 'scrapecreators', 'reddit'],
  defaultTools: [...LARRY_CAPABILITIES.tools],
  requiredTools: [...LARRY_CAPABILITIES.tools],
};
