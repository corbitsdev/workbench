import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import { buildWalterSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const WALTER_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  {
    source: 'invoker',
    resource: 'tool:mail_reply',
    action: 'invoke',
  },
];

export const WALTER_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
];

export const WALTER_DEPLOY_PROMPT: string = buildWalterSystemPrompt('Walter', { xml: true });

export const WALTER_CAPABILITIES = {
  tools: [],
} as const;

export const WALTER_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Walter - Writer',
  name: 'Walter',
  systemPrompt: WALTER_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible'],
  defaultTools: [...WALTER_CAPABILITIES.tools],
  requiredTools: [...WALTER_CAPABILITIES.tools],
};
