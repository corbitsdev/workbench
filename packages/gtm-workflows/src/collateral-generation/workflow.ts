import { LLM_CREDENTIAL_NAME } from '@workbench/agents';
import type { WorkflowType } from '@workbench/workflow-core';
import {
  createPainPointArtifacts,
  createTranscriptArtifacts,
  deriveCollateralRunTitle,
  isCollateralKind,
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
          providerName: 'openai-compatible',
          source: 'tenant',
          name: LLM_CREDENTIAL_NAME,
        },
      ],
    },
    {
      name: 'generate',
      label: 'Generate',
      description: 'Generate collateral from the selected pain points.',
      credentialRequirements: [
        {
          providerName: 'openai-compatible',
          source: 'tenant',
          name: LLM_CREDENTIAL_NAME,
        },
      ],
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      transcriptId: { type: 'string', description: 'Transcript ID from intake' },
      transcriptSource: { type: 'string', enum: ['paste', 'granola', 'artifact'] },
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
  deriveCurrentStep: (status) => {
    switch (status) {
      case 'pending':
      case 'analyzing':
        return 'analyze';
      case 'running':
      case 'generating':
      case 'reviewing':
      case 'done':
        return 'generate';
      case 'failed':
        return 'intake';
      default:
        throw new Error(`Unknown workflow status: ${status}`);
    }
  },
  serializeStepState: ({ intakeTranscript, painPoints, artifacts }) => {
    const collateral = artifacts.filter((a) => isCollateralKind(a.kind));
    return {
      intake: {
        completed: true,
        transcriptId: intakeTranscript?.id ?? null,
        transcript: intakeTranscript?.content,
      },
      analyze: { completed: painPoints.length > 0, painPoints },
      generate: { completed: collateral.length > 0, artifacts: collateral },
    };
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
