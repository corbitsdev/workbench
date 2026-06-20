import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const intakeAgent = defineAgent({
  id: 'resource-enrichment-intake',
  description: 'Parses an uploaded resource file into structured rows.',
  systemPrompt:
    'You are a resource intake agent. Parse the uploaded resource file into structured rows.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const enrichAgent = defineAgent({
  id: 'resource-enrichment-enrich',
  description: 'Generates option variants for each row.',
  systemPrompt:
    'You are a resource enrichment agent. Generate a set of option variants per field for each row.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const exportAgent = defineAgent({
  id: 'resource-enrichment-export',
  description: 'Assembles the chosen options into a downloadable CSV.',
  systemPrompt:
    'You are a resource export agent. Assemble the reviewer-chosen options into a downloadable CSV.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const kind = 'resource-enrichment';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: step({ agent: intakeAgent }),
    enrich: step({ agent: enrichAgent, after: ['intake'] }),
    review: awaitSignal({ name: 'selection-approval', after: ['enrich'] }),
    export: step({ agent: exportAgent, after: ['review'] }),
  },
});
