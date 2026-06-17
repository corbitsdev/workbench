import type { WorkflowCredentialRequirement, WorkflowType } from '@workbench/workflow-core';
import { resourceEnrichmentSteps, resourceEnrichmentWorkflow } from '../resource-enrichment';
import {
  SEO_INFERENCE_CREDENTIAL_NAME,
  SEO_INFERENCE_MODEL,
  SEO_INFERENCE_PROVIDER,
} from './constants';

const SEO_INFERENCE_REQUIREMENT: WorkflowCredentialRequirement = {
  providerName: SEO_INFERENCE_PROVIDER,
  source: 'tenant',
  name: SEO_INFERENCE_CREDENTIAL_NAME,
  defaultModel: SEO_INFERENCE_MODEL,
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
