import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const intakeAgent = defineAgent({
  id: 'seo-intake',
  description: 'Parses an uploaded product workbook into resource rows.',
  systemPrompt:
    'You are a resource intake agent. Parse the uploaded product workbook into rows for enrichment.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

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

const exportAgent = defineAgent({
  id: 'seo-export',
  description: 'Assembles the chosen SEO options into a downloadable CSV.',
  systemPrompt:
    'You are a CSV export agent. Assemble the reviewer-selected SEO options into a downloadable CSV.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'SEO Enrichment';
export const kind = 'seo-enrichment';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: step({ agent: intakeAgent }),
    enrich: step({ agent: enrichAgent, after: ['intake'] }),
    review: awaitSignal({ name: 'row-selection', after: ['enrich'] }),
    export: step({ agent: exportAgent, after: ['review'] }),
  },
});
