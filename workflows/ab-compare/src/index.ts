import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const executeAgent = defineAgent({
  id: 'blind-ab-execute',
  description: 'Runs the shared prompt across each selected provider branch.',
  systemPrompt:
    'You are an execution agent. Run the shared prompt against your assigned provider and return its output for blind comparison.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const compareAgent = defineAgent({
  id: 'blind-ab-compare',
  description: 'Blind-ranks the provider outputs and prepares them for human review.',
  systemPrompt:
    'You are a comparison agent. Rank the provider outputs blind, from best to worst, and summarize the differences for human review.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const persistAgent = defineAgent({
  id: 'blind-ab-persist',
  description: 'Saves the ranked comparison results as artifacts.',
  systemPrompt: 'You are a persistence agent. Save the ranked comparison results as artifacts.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'A/B Compare';
export const description = 'Run two content variants through a blind comparison and surface ranked results.';
export const kind = 'ab-compare';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    input: awaitSignal({ name: 'input' }),
    execute: step({ agent: executeAgent, input: { from: 'steps.input.output' }, after: ['input'] }),
    compare: step({ agent: compareAgent, input: { from: 'steps.execute.output' }, after: ['execute'] }),
    review: awaitSignal({ name: 'comparison-review', after: ['compare'] }),
    persist: step({ agent: persistAgent, after: ['review'] }),
  },
});
