import type { GrantRequirement, CredentialRequirement } from '@intx/types';
import { buildBobbySystemPrompt } from './prompt';
import type { AgentDeployDescriptor } from '../deploy-descriptor';
import { LLM_CREDENTIAL_NAME } from '../constants';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const BOBBY_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  {
    source: 'invoker',
    resource: 'tool:mail_search',
    action: 'invoke',
  },
  {
    source: 'invoker',
    resource: 'tool:mail_reply',
    action: 'invoke',
  },
];

export const BOBBY_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
    name: LLM_CREDENTIAL_NAME,
  },
];

export const BOBBY_DEPLOY_PROMPT: string = buildBobbySystemPrompt('Bobby', { xml: true });

export const BOBBY_CAPABILITIES = {
  tools: [
    'browser_create_session',
    'browser_navigate',
    'browser_get_snapshot',
    'browser_click',
    'browser_type',
    'browser_get_text',
    'browser_screenshot',
    'browser_close_session',
    'mail_search',
    'mail_reply',
  ],
} as const;

export const BOBBY_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: 'Bobby — the Browser',
  name: 'Bobby',
  systemPrompt: BOBBY_DEPLOY_PROMPT,
  credentialProviderNames: ['openai-compatible', 'browserbase'],
  defaultTools: [...BOBBY_CAPABILITIES.tools],
  requiredTools: [...BOBBY_CAPABILITIES.tools],
};
