import type { CredentialRequirement } from '@intx/types';
import { buildLoopAgentSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type CredentialRequirementType = typeof CredentialRequirement.infer;

export const LOOP_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

export const LOOP_DEPLOY_PROMPT: string = buildLoopAgentSystemPrompt('Loop', { xml: true });

export const LOOP_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Loop — Research Intelligence',
  name: 'Loop',
  systemPrompt: LOOP_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible'],
  defaultTools: [],
  requiredTools: [],
};
