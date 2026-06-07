// SCAFFOLD: Copy this directory, rename the package, and replace the stubs.
// Wire provisioning in apps/hub/src/lib/tenant-provisioning.ts.
//
// Steps:
//   1. cp -r packages/tool-agent packages/agent-<name>
//   2. Update name in package.json and exports in index.ts
//   3. Fill in AGENT_NAME, system prompt, and capabilities.tools list
//   4. Add provisioning call in tenant-provisioning.ts

import type { CredentialRequirement } from '@intx/types';

type CredentialRequirementType = typeof CredentialRequirement.infer;

export const AGENT_NAME = 'RenameMe';

export const RENAME_ME_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: 'openai-compatible',
    source: 'tenant',
  },
  // Add additional tool providers here if the agent needs credentials resolved
  // at launch time (e.g. for non-tool uses). For hub-proxied tools, credentials
  // are resolved at execution time — no entry needed here.
];

// Tools this agent can use. Must match keys in KNOWN_TOOLS (hub's tool-registry.ts).
// The hub builds HarnessConfig.tools from this list at launch time.
export const RENAME_ME_CAPABILITIES = {
  tools: [] as string[],
} as const;

export const RENAME_ME_DEPLOY_PROMPT =
  'You are RenameMe. Describe the agent role and behavior here.';
