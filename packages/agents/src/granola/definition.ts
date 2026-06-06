import type { GrantRequirement, CredentialRequirement } from '@intx/types';
import { buildGranolaSystemPrompt } from './prompt';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * Grant requirements for the Granola agent.
 *
 * Oat must be able to reply to inbound mail from Myra. It must never
 * initiate outbound mail — tool:mail.send is not granted.
 */
export const GRANOLA_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  {
    source: 'invoker',
    resource: 'tool:mail_reply',
    action: 'invoke',
  },
];

/**
 * Credential requirements for the Granola agent.
 *
 *   - granola:    Workspace-level Granola API key (tenant credential). Shared
 *                 across all users in the workspace.
 *   - openai-compatible: Workspace-level LLM credential for inference.
 */
export const GRANOLA_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'granola',
    source: 'tenant',
  },
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
];

/**
 * Static deploy prompt for the Granola agent definition.
 */
export const GRANOLA_DEPLOY_PROMPT: string = buildGranolaSystemPrompt('Oat', 'xml');
