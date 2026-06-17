import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { WorkflowCredentialRequirement, WorkflowType } from '@workbench/workflow-core';
import { resourceEnrichmentSteps, resourceEnrichmentWorkflow } from '../resource-enrichment';

const SEO_INFERENCE_REQUIREMENT: WorkflowCredentialRequirement = {
  providerName: 'openai-compatible',
  source: 'tenant',
  name: LLM_CREDENTIAL_NAME,
  defaultModel: LLM_DEFAULT_MODEL,
};

// Specific kind: composes the resource-enrichment base (step shape + generic
// hooks) and supplies the SEO domain — xlsx intake, per-row image+LLM enrich,
// CSV export (M2). The enrich step needs an inference credential; every other
// step and hook is inherited unchanged from the base.
export const seoEnrichmentWorkflow: WorkflowType = {
  ...resourceEnrichmentWorkflow,
  kind: 'seo-enrichment',
  name: 'SEO Enrichment',
  description:
    'Generate SEO titles, descriptions and summaries for each product row, pick one of each, download a CSV.',
  steps: resourceEnrichmentSteps.map((step) =>
    step.name === 'enrich' ? { ...step, credentialRequirements: [SEO_INFERENCE_REQUIREMENT] } : step
  ),
};
