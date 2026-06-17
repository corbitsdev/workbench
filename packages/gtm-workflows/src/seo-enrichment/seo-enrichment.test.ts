import { describe, expect, it } from 'bun:test';
import { seoEnrichmentWorkflow } from './index';

describe('seoEnrichmentWorkflow definition', () => {
  it('is a specific kind composed from the resource-enrichment base', () => {
    expect(seoEnrichmentWorkflow.kind).toBe('seo-enrichment');
    expect(seoEnrichmentWorkflow.steps.map((s) => s.name)).toEqual([
      'intake',
      'enrich',
      'review',
      'export',
    ]);
    expect(seoEnrichmentWorkflow.deriveCurrentStep).toBeDefined();
    expect(seoEnrichmentWorkflow.serializeStepState).toBeDefined();
  });

  it('requires an inference credential on the enrich step', () => {
    const enrich = seoEnrichmentWorkflow.steps.find((s) => s.name === 'enrich');
    if (!enrich) throw new Error('enrich step missing');
    expect(enrich.credentialRequirements.length).toBeGreaterThan(0);
    expect(enrich.credentialRequirements[0]?.providerName).toBe('openai-compatible');
  });
});
