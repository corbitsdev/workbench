import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import type { ToolPackagePin } from '@intx/types/tool-packages';
import { canonicalizeToolNames } from '../tool-names';
import { buildLarrySystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

/**
 * Native tool packages Larry pins. `hackernews_search` is served by the
 * materialized package; it stays in `LARRY_CAPABILITIES.tools` so the
 * instance is granted it, and the sidecar lets the package shadow the
 * hub-proxy entry of the same name during the coexistence window.
 */
export const LARRY_TOOL_PACKAGES: ToolPackagePin[] = [
  { name: '@workbench/tools-hackernews', version: '^0.1.0' },
  { name: '@workbench/tools-polymarket', version: '^0.1.0' },
  { name: '@workbench/tools-last30days', version: '^0.1.0' },
  { name: '@workbench/tools-exa', version: '^0.1.0' },
  { name: '@workbench/tools-github', version: '^0.1.0' },
  { name: '@workbench/tools-reddit', version: '^0.1.0' },
  { name: '@workbench/tools-x', version: '^0.1.0' },
  { name: '@workbench/tools-youtube', version: '^0.1.0' },
  { name: '@workbench/tools-bluesky', version: '^0.1.0' },
  { name: '@workbench/tools-scrapecreators', version: '^0.1.0' },
  { name: '@workbench/tools-artifact', version: '^0.1.0' },
];

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
  tools: canonicalizeToolNames([
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
  ]),
} as const;

export const LARRY_MODEL_CONFIG = { defaultModel: 'deepseek-v4-flash' } as const;

export const LARRY_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Larry — last30days Research',
  name: 'Larry',
  modelConfig: LARRY_MODEL_CONFIG,
  systemPrompt: LARRY_DEPLOY_PROMPT,
  credentialProviderNames: [
    'openai-compatible',
    'xai',
    'github',
    'scrapecreators',
    'exa',
    'youtube',
    'bluesky',
  ],
  defaultTools: [...LARRY_CAPABILITIES.tools],
  requiredTools: [...LARRY_CAPABILITIES.tools],
  toolPackages: LARRY_TOOL_PACKAGES,
};
