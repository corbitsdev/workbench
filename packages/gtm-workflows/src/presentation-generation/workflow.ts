import type { WorkflowType } from '@workbench/workflow-core';
import { createPresentationIntakeArtifacts, derivePresentationRunTitle } from './artifacts';

export const presentationGenerationWorkflow: WorkflowType = {
  kind: 'presentation-generation',
  name: 'Presentation Generation',
  description: 'Turn call transcripts and notes into branded Gamma presentations via Geralt',
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
      description: 'Dispatch to your Geralt session to build the deck.',
      credentialRequirements: [],
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
