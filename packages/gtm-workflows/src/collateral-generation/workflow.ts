import type { WorkflowType } from '@workbench/workflow-core';

export const collateralGenerationWorkflow: WorkflowType = {
  kind: 'collateral-generation',
  name: 'Collateral Generation',
  description:
    'Turn call transcripts into sales collateral (emails, LinkedIn posts, one-pagers, battercards)',
  credentialRequirements: [
    {
      providerName: 'openai-compatible',
      source: 'tenant',
      name: 'Collateral LLM',
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      transcriptId: { type: 'string', description: 'Transcript ID from intake' },
      transcriptSource: { type: 'string', enum: ['paste', 'granola'] },
      companyName: { type: 'string', description: 'Company name (optional)' },
    },
    required: ['transcriptId', 'transcriptSource'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    },
  },
};
