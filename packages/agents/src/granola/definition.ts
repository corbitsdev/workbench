import type { GrantRequirement, CredentialRequirement } from '@intx/types';
import { canonicalizeToolNames } from '../tool-names';
import { buildGranolaSystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * Grant requirements for the Granola agent.
 *
 * Oat must be able to reply to inbound mail from Myra. It must never
 * initiate outbound mail — tool:mail.send is not granted.
 */
export const GRANOLA_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: 'invoker', resource: 'tool:mail_search', action: 'invoke' },
  { source: 'invoker', resource: 'tool:mail_reply', action: 'invoke' },
];

/**
 * Credential requirements for the Granola agent.
 *
 * Only the LLM credential is declared here — Interchange resolves these as
 * inference sources at launch time. The granola API key is a non-LLM
 * credential resolved by the hub at tool execution time via the tool registry.
 */
export const GRANOLA_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

/**
 * Static deploy prompt for the Granola agent definition.
 */
export const GRANOLA_DEPLOY_PROMPT: string = buildGranolaSystemPrompt('Oat', {
  xml: true,
});

/**
 * Capabilities bag for the Granola agent. Consumed by the hub at launch time
 * to configure tools.
 */
export const GRANOLA_CAPABILITIES = {
  tools: canonicalizeToolNames([
    'granola_list_notes',
    'granola_get_note',
    'granola_list_folders',
    'mail_search',
    'mail_reply',
  ]),
} as const;

export const GRANOLA_MODEL_CONFIG = { defaultModel: 'deepseek-v4-flash' } as const;

export const GRANOLA_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Oat — Call Intelligence',
  name: 'Oat',
  modelConfig: GRANOLA_MODEL_CONFIG,
  systemPrompt: GRANOLA_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible', 'granola'],
  defaultTools: [...GRANOLA_CAPABILITIES.tools],
  requiredTools: [...GRANOLA_CAPABILITIES.tools],
};
