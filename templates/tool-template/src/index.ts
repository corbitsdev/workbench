// SCAFFOLD: Copy this directory, rename the package in package.json, and replace
// the stubs below. To register the tool with the hub, spread RENAME_ME_HUB_TOOLS
// into KNOWN_TOOLS in apps/hub/src/lib/tool-registry.ts. No sidecar changes needed.
//
// Steps:
//   1. cp -r packages/tool-template packages/tools-<name>
//   2. Update name in package.json and this file
//   3. Register provider in Interchange DB (providerName must match)
//   4. Add one import + spread to apps/hub/src/lib/tool-registry.ts

import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

// Replace with the Interchange provider name for this tool's credential.
const PROVIDER_NAME = 'rename-me' as const;

export type RenameToolsConfig = {
  apiKey: string;
  baseURL: string;
};

export const RENAME_ME_DEFINITION: ToolDefinition = {
  name: 'rename_me_action',
  description: 'Describe what this tool does for the model.',
  inputSchema: {
    type: 'object',
    properties: {
      // Add input parameters here
    },
    required: [],
  },
};

// oxlint-disable-next-line no-unused-vars
export function createRenameMeTools(config: RenameToolsConfig): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: RENAME_ME_DEFINITION,
      handler: async (_args, _signal) => {
        // Implement the tool. Use config.apiKey and config.baseURL.
        // Return a JSON string the model can read.
        throw new Error('Not implemented');
      },
    },
  ];
}

export const RENAME_ME_HUB_TOOLS = {
  rename_me_action: {
    definition: RENAME_ME_DEFINITION,
    providerName: PROVIDER_NAME,
    createTools: (config: { apiKey: string; baseURL: string }) => createRenameMeTools(config),
  },
};
