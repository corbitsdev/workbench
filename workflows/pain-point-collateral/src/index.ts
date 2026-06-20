import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const intakeAgent = defineAgent({
  id: 'pain-point-collateral-intake',
  description: 'Collects the call note to analyze via Granola.',
  systemPrompt:
    'You are a call intake agent. List available Granola notes and ask the user to select one to analyze for pain points.',
  tools: [],
  capabilities: canonicalizeToolNames(['granola_list_notes', 'granola_get_note']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const analyzeAgent = defineAgent({
  id: 'pain-point-collateral-analyze',
  description: 'Extracts pain points from a call transcript.',
  systemPrompt:
    'You are a pain-point extraction agent. You will receive the call transcript in your first message. Read it and identify key customer pain points.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const generateAgent = defineAgent({
  id: 'pain-point-collateral-generate',
  description: 'Generates sales collateral from selected pain points.',
  systemPrompt:
    'You are a collateral generation agent. Generate the requested sales collateral from the provided pain points.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'Pain Point Collateral';
export const description = 'Analyze a call transcript for customer pain points and generate targeted sales collateral.';
export const kind = 'pain-point-collateral';

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
