import { GrantRequirement, CredentialRequirement } from '@intx/types';
import { canonicalizeToolNames } from '../tool-names';
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

export const PERSONAL_AGENT_MODEL_CONFIG = { defaultModel: 'kimi-k2.6' } as const;

/** Display name of the personal agent; also the per-tenant seed idempotency key. */
export const PERSONAL_AGENT_NAME = 'Myra';

export const PERSONAL_AGENT_DEPLOY_PROMPT: string = buildPersonalAgentSystemPrompt(
  PERSONAL_AGENT_NAME,
  {
    xml: true,
  }
);

/**
 * Base toolset every Myra instance starts with. Single source of truth for the
 * shared template — per-user tool customization adds to this on each user's own
 * agent definition (see CL-1448). Add base tools here, not in apps.
 *
 * Tool grants (`tool:<name>/invoke`) are synthesized from this list at launch
 * (persistInstanceToolGrants), so listing a tool here is what authorizes it.
 */
export const PERSONAL_AGENT_BASE_TOOLS: string[] = canonicalizeToolNames([
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'exa_search',
  'linear_list_issues',
  'linear_get_issue',
  'linear_list_teams',
  'linear_list_users',
  'attio_list_objects',
  'attio_query_records',
  'attio_get_record',
  'attio_list_workspace_members',
  'granola_list_notes',
  'granola_get_note',
  'granola_list_folders',
  'artifact_create',
  'artifact_read',
  'artifact_write',
  'artifact_list',
  'list_agents',
  'list_principals',
]);
