import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import {
  canonicalizeToolNames,
  deterministicToolStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from '@workbench/agents';
import { SEO_ENRICH_SYSTEM_PROMPT } from './prompts';

const enrichAgent = defineAgent({
  id: 'seo-enrich',
  description: 'Extracts SEO metadata fields from a product image and target page URL.',
  systemPrompt: SEO_ENRICH_SYSTEM_PROMPT,
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_read']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'SEO Enrichment from Image';
export const description =
  'Extract SEO metadata from a product image and enrich a target page URL.';
export const kind = 'seo-enrichment-from-image';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: awaitSignal({ name: 'intake' }),
    enrich: step({ agent: enrichAgent, input: { from: 'steps.intake.output' }, after: ['intake'] }),
    review: awaitSignal({ name: 'row-selection', after: ['enrich'] }),
    persist: deterministicToolStep({
      id: 'seo-enrich-persist',
      tool: 'artifact_create',
      input: { from: 'steps.review.output' },
      argMap: {
        content: { from: 'selectedIds' },
        title: { literal: 'SEO Enrichment Results' },
        kind: { literal: 'document' },
      },
      after: ['review'],
    }),
  },
});
