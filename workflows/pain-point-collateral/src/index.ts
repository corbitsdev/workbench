import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

export { IntakeForm } from './IntakeForm';

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
export const kind = 'pain-point-collateral';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    analyze: step({ agent: analyzeAgent }),
    generate: step({ agent: generateAgent, after: ['analyze'] }),
    approval: awaitSignal({ name: 'artifact-approval', after: ['generate'] }),
  },
});
