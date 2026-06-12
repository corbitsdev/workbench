import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import { buildHammySystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const HAMMY_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: 'invoker', resource: 'tool:mail_reply', action: 'invoke' },
];

export const HAMMY_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

export const HAMMY_DEPLOY_PROMPT: string = buildHammySystemPrompt('Hammy', { xml: true });

export const HAMMY_CAPABILITIES = {
  tools: ['read_file', 'write_file', 'edit_file', 'artifact_link_file', 'mail_reply'],
} as const;

export const HAMMY_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Hammy - Humanizer',
  name: 'Hammy',
  systemPrompt: HAMMY_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible'],
  defaultTools: [...HAMMY_CAPABILITIES.tools],
  requiredTools: [...HAMMY_CAPABILITIES.tools],
};
