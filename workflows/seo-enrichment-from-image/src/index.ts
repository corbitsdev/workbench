import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const enrichAgent = defineAgent({
  id: 'seo-enrich',
  description: 'Generates SEO title, description, and summary variants for each product row.',
  systemPrompt:
    'You are an SEO enrichment agent. For each product row, generate five title, description, and summary variants.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'SEO Enrichment from Image';
export const description = 'Extract SEO metadata from a product image and enrich a target page URL.';
export const kind = 'seo-enrichment-from-image';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: awaitSignal({ name: 'intake' }),
    enrich: step({ agent: enrichAgent, input: { from: 'steps.intake.output' }, after: ['intake'] }),
    review: awaitSignal({ name: 'row-selection', after: ['enrich'] }),
  },
});
