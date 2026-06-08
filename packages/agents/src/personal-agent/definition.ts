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
      resource: 'tool:mail_send',
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
    source: 'tenant',
    name: 'Myra LLM',
  },
];

export const PERSONAL_AGENT_DEPLOY_PROMPT: string = buildPersonalAgentSystemPrompt('Myra', {
  xml: true,
});

/**
 * Base toolset every Myra instance starts with. Single source of truth for the
 * shared template — per-user tool customization adds to this on each user's own
 * agent definition (see CL-1448). Empty today; add base tools here, not in apps.
 */
export const PERSONAL_AGENT_BASE_TOOLS: string[] = [];
