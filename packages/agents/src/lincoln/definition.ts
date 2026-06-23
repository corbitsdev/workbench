import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import { canonicalizeToolNames } from '../tool-names';
import { buildLincolnSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const LINCOLN_GRANT_REQUIREMENTS: GrantRequirementType[] = [];

export const LINCOLN_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

export const LINCOLN_DEPLOY_PROMPT: string = buildLincolnSystemPrompt('Lincoln');

export const LINCOLN_CAPABILITIES = {
  tools: canonicalizeToolNames([
    'read_file',
    'write_file',
    'edit_file',
    'artifact_link_file',
    'firecrawl_scrape',
    'firecrawl_search',
  ]),
} as const;

export const LINCOLN_MODEL_CONFIG = { defaultModel: 'deepseek-v4-flash' } as const;

export const LINCOLN_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Lincoln — LinkedIn Writer',
  name: 'Lincoln',
  modelConfig: LINCOLN_MODEL_CONFIG,
  systemPrompt: LINCOLN_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible', 'firecrawl'],
  defaultTools: [...LINCOLN_CAPABILITIES.tools],
  requiredTools: [...LINCOLN_CAPABILITIES.tools],
};
