import type { CredentialRequirement } from '@intx/types';
import { buildLoopAgentSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';

type CredentialRequirementType = typeof CredentialRequirement.infer;

export const LOOP_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
];

export const LOOP_DEPLOY_PROMPT: string = buildLoopAgentSystemPrompt('Loop', 'xml');

export const LOOP_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Loop — Research Intelligence',
  name: 'Loop',
  systemPrompt: LOOP_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible'],
  defaultTools: [],
  requiredTools: [],
};
