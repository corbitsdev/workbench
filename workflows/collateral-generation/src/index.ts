import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const intakeAgent = defineAgent({
  id: 'collateral-intake',
  description: 'Fetches a call transcript from Granola or accepts a pasted transcript.',
  systemPrompt:
    'You are a transcript intake agent. Fetch the requested transcript from Granola or accept a pasted transcript.',
  tools: [],
  capabilities: canonicalizeToolNames(['granola_list_notes', 'granola_get_note']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const analyzeAgent = defineAgent({
  id: 'collateral-analyze',
  description: 'Extracts pain points from a call transcript.',
  systemPrompt:
    'You are a pain-point extraction agent. Read the transcript and identify key customer pain points.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const generateAgent = defineAgent({
  id: 'collateral-generate',
  description: 'Generates sales collateral from selected pain points.',
  systemPrompt:
    'You are a collateral generation agent. Generate the requested sales collateral from the provided pain points.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const kind = 'collateral-generation';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: step({ agent: intakeAgent }),
    analyze: step({ agent: analyzeAgent, after: ['intake'] }),
    generate: step({ agent: generateAgent, after: ['analyze'] }),
    approval: awaitSignal({ name: 'artifact-approval', after: ['generate'] }),
  },
});
