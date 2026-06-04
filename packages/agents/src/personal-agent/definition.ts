import { GrantRequirement, CredentialRequirement } from '@intx/types';
import { buildPersonalAgentSystemPrompt } from './prompt';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export function buildPersonalAgentGrantRequirements(
  workbenchTenantId: string
): GrantRequirementType[] {
  return [
    {
      source: 'invoker',
      resource: 'tool:mail.send',
      action: 'invoke',
    },
    {
      source: 'invoker',
      resource: `tenant:${workbenchTenantId}`,
      action: 'deliver',
    },
  ];
}

export const PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'invoker',
  },
];

export const PERSONAL_AGENT_DEPLOY_PROMPT: string = buildPersonalAgentSystemPrompt('Myra', 'xml');
