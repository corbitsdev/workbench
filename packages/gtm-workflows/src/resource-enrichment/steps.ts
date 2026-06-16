import type { WorkflowStepDefinition } from '@workbench/workflow-core';

// The generic resource-enrichment step shape. Specific kinds (e.g.
// seo-enrichment) reuse these names and inject their own credential
// requirements onto the enrich step; the base declares none.
export const resourceEnrichmentSteps: WorkflowStepDefinition[] = [
  {
    name: 'intake',
    label: 'Intake',
    description: 'Parse the uploaded resource file into rows.',
    credentialRequirements: [],
  },
  {
    name: 'enrich',
    label: 'Enrich',
    description: 'Generate option variants for each row.',
    credentialRequirements: [],
  },
  {
    name: 'review',
    label: 'Review',
    description: 'Pick one option per field for each row.',
    credentialRequirements: [],
  },
  {
    name: 'export',
    label: 'Export',
    description: 'Assemble the chosen options into a downloadable CSV.',
    credentialRequirements: [],
  },
];
