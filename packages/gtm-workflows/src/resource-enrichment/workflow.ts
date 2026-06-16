import type { WorkflowType } from '@workbench/workflow-core';
import {
  deriveResourceEnrichmentCurrentStep,
  deriveResourceEnrichmentRunTitle,
  selectResourceEnrichmentArtifactKinds,
  serializeResourceEnrichmentStepState,
} from './hooks';
import { resourceEnrichmentSteps } from './steps';

// Generic base: intake → enrich → review → export over the selection artifact
// model. It owns the step shape and the generic hooks; specific kinds (e.g.
// seo-enrichment) compose it and supply the real intake/enrich logic. Not
// registered on its own — it is a template, not a runnable workflow.
export const resourceEnrichmentWorkflow: WorkflowType = {
  kind: 'resource-enrichment',
  name: 'Resource Enrichment',
  description:
    'Upload a resource file, generate option variants per row, pick one per field, download a CSV.',
  steps: resourceEnrichmentSteps,
  inputSchema: {
    type: 'object',
    properties: {
      uploadId: { type: 'string', description: 'Upload ID of the resource file' },
      filename: { type: 'string', description: 'Original filename (optional)' },
    },
    required: ['uploadId'],
  },
  deriveRunTitle: deriveResourceEnrichmentRunTitle,
  deriveCurrentStep: deriveResourceEnrichmentCurrentStep,
  serializeStepState: serializeResourceEnrichmentStepState,
  selectGenerateArtifactKinds: selectResourceEnrichmentArtifactKinds,
};
