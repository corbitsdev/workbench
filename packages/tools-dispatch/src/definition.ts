import type { ToolDefinition } from '@intx/types/runtime';

export const DISPATCH_AGENT_DEFINITION: ToolDefinition = {
  name: 'dispatch_agent',
  description:
    'Create a new running instance of an existing agent definition and send it an initial task. Returns the new instance ID and address so the caller can track or communicate with it later.',
  inputSchema: {
    type: 'object',
    properties: {
      agentDefinitionId: {
        type: 'string',
        description: 'The agent definition ID to spawn an instance from',
      },
      task: {
        type: 'string',
        description: 'The initial message to send to the new agent instance',
      },
    },
    required: ['agentDefinitionId', 'task'],
  },
};
