import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { WorkflowType } from '@workbench/workflow-core';
import { createPresentationIntakeArtifacts, derivePresentationRunTitle } from './artifacts';

export const presentationGenerationWorkflow: WorkflowType = {
  kind: 'presentation-generation',
  name: 'Presentation Generation',
  description: 'Turn call transcripts and notes into branded Gamma presentations',
  steps: [
    {
      name: 'template',
      label: 'Template',
      description: 'Pick a Gamma template and set audience, tone, and goal.',
      credentialRequirements: [],
    },
    {
      name: 'source',
      label: 'Source',
      description:
        'Choose where the content comes from: a Granola call, an existing artifact, or pasted text.',
      credentialRequirements: [],
      tools: ['granola_list_notes', 'granola_get_note'],
    },
    {
      name: 'generate',
      label: 'Generate',
      description: 'Run generate → review → Gamma render pipeline to produce the deck.',
      credentialRequirements: [
        {
          providerName: 'openai-compatible',
          source: 'tenant',
          name: LLM_CREDENTIAL_NAME,
          defaultModel: LLM_DEFAULT_MODEL,
        },
      ],
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      templateId: { type: 'string', description: 'Gamma template ID or "auto"' },
      audience: { type: 'string', description: 'Target audience' },
      tone: { type: 'string', enum: ['Formal', 'Conversational', 'Technical'] },
      goal: { type: 'string', description: 'Goal of the presentation' },
      transcriptSource: { type: 'string', enum: ['granola', 'artifact', 'paste'] },
      transcriptId: { type: 'string', description: 'Transcript row ID (granola path)' },
      sourceArtifactId: { type: 'string', description: 'Existing artifact ID (artifact path)' },
      sourceText: { type: 'string', description: 'Pasted content (paste path)' },
      callTitle: { type: 'string', description: 'Title of the source call or note' },
      companyName: { type: 'string', description: 'Company name for display' },
      artifactTitle: { type: 'string', description: 'Artifact title (artifact path)' },
    },
    required: [],
  },
  deriveRunTitle: derivePresentationRunTitle,
  serializeStepState: ({ status, input }) => {
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    // Completion reflects whether each step's own gate was passed, recorded
    // explicitly by the step handler — never inferred from a later step.
    return {
      template: {
        completed: input.templateSubmitted === true,
        templateId: str(input.templateId),
        audience: str(input.audience),
        tone: str(input.tone),
        goal: str(input.goal),
      },
      source: {
        completed: Boolean(str(input.transcriptSource)),
        transcriptSource: str(input.transcriptSource),
        callTitle: str(input.callTitle),
      },
      generate: {
        completed: status === 'done',
        dispatched:
          status === 'generating' ||
          status === 'reviewing' ||
          status === 'rendering' ||
          status === 'done',
        gammaUrl: str(input.gammaUrl),
        gammaId: str(input.gammaId),
      },
    };
  },
  deriveCurrentStep: (status) => {
    switch (status) {
      case 'pending':
      case 'failed':
        return 'template';
      case 'analyzing':
        return 'source';
      case 'running':
      case 'generating':
      case 'reviewing':
      case 'rendering':
      case 'done':
        return 'generate';
      default:
        throw new Error(`Unknown workflow status: ${status}`);
    }
  },
  createIntakeArtifacts: ({ input, content, callTitle }) => {
    const transcriptSource = input.transcriptSource;
    if (
      transcriptSource !== 'granola' &&
      transcriptSource !== 'paste' &&
      transcriptSource !== 'artifact'
    ) {
      return [];
    }
    return createPresentationIntakeArtifacts({
      content,
      ...(callTitle !== undefined && { callTitle }),
      transcriptSource,
    });
  },
};
