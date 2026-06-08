import type { WorkflowType } from '@workbench/workflow-core';
import {
  createPainPointArtifacts,
  createTranscriptArtifacts,
  deriveCollateralRunTitle,
  selectCollateralTypeIds,
} from './artifacts';

export const collateralGenerationWorkflow: WorkflowType = {
  kind: 'collateral-generation',
  name: 'Collateral Generation',
  description:
    'Turn call transcripts into sales collateral (emails, LinkedIn posts, one-pagers, battlecards)',
  steps: [
    {
      name: 'intake',
      label: 'Intake',
      description: 'Pull a call transcript from Granola or accept a pasted transcript.',
      credentialRequirements: [
        {
          providerName: 'granola',
          source: 'tenant',
          name: 'Granola',
        },
      ],
      tools: ['granola_list_notes', 'granola_get_note'],
    },
    {
      name: 'analyze',
      label: 'Analyze',
      description: 'Extract pain points from the transcript.',
      credentialRequirements: [
        {
          // No name: the step uses whatever openai-compatible LLM credential the
          // tenant has configured. Add a name here only if a tenant is expected
          // to hold several openai-compatible credentials and one must be picked.
          providerName: 'openai-compatible',
          source: 'tenant',
        },
      ],
    },
    {
      name: 'generate',
      label: 'Generate',
      description: 'Generate collateral from the selected pain points.',
      credentialRequirements: [
        {
          // No name: the step uses whatever openai-compatible LLM credential the
          // tenant has configured. Add a name here only if a tenant is expected
          // to hold several openai-compatible credentials and one must be picked.
          providerName: 'openai-compatible',
          source: 'tenant',
        },
      ],
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
  deriveRunTitle: deriveCollateralRunTitle,
  createIntakeArtifacts: ({ content, callTitle }) =>
    createTranscriptArtifacts({ content, callTitle }),
  createAnalyzeArtifacts: ({ input, painPoints, companyName }) =>
    createPainPointArtifacts({
      points: painPoints,
      companyName,
      runTitle: deriveCollateralRunTitle(input),
    }),
  selectGenerateArtifactKinds: selectCollateralTypeIds,
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
