import { GrantRequirement, CredentialRequirement } from '@intx/types';
import { buildPersonalAgentSystemPrompt } from './prompt';
import { LLM_CREDENTIAL_NAME } from '../constants';

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
    name: LLM_CREDENTIAL_NAME,
  },
];

export const PERSONAL_AGENT_DEPLOY_PROMPT: string = buildPersonalAgentSystemPrompt('Myra', {
  xml: true,
});

/**
 * Base toolset every Myra instance starts with. Single source of truth for the
 * shared template — per-user tool customization adds to this on each user's own
 * agent definition (see CL-1448). Add base tools here, not in apps.
 *
 * Tool grants (`tool:<name>/invoke`) are synthesized from this list at launch
 * (persistInstanceToolGrants), so listing a tool here is what authorizes it.
 * Mail tools are provided by the sidecar harness — `mail_send` is also covered
 * by the invoker delegation grant in `buildPersonalAgentGrantRequirements`.
 */
export const PERSONAL_AGENT_BASE_TOOLS: string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'exa_search',
  'artifact_create',
  'artifact_read',
  'artifact_write',
  'artifact_list',
  'list_agents',
  'list_principals',
  'mail_send',
  'mail_reply',
  'mail_search',
  'mail_read',
  'mail_wait',
];
