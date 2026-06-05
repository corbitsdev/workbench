import type { CredentialRequirement } from '@intx/types';
import { buildLoopAgentSystemPrompt } from './prompt';

type CredentialRequirementType = typeof CredentialRequirement.infer;

export const LOOP_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
];

export const LOOP_DEPLOY_PROMPT: string = buildLoopAgentSystemPrompt('Loop', 'xml');
