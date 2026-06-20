import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { canonicalizeToolNames, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const templateAgent = defineAgent({
  id: 'presentation-template',
  description: 'Picks a Gamma template and sets audience, tone, and goal.',
  systemPrompt:
    'You are a presentation setup agent. Pick a Gamma template and capture the audience, tone, and goal for the deck.',
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const sourceAgent = defineAgent({
  id: 'presentation-source',
  description:
    'Chooses where content comes from: a Granola call, an existing artifact, or pasted text.',
  systemPrompt:
    'You are a content source agent. Resolve the deck content from a Granola call, an existing artifact, or pasted text.',
  tools: [],
  capabilities: canonicalizeToolNames(['granola_list_notes', 'granola_get_note']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const generateAgent = defineAgent({
  id: 'presentation-generate',
  description: 'Drafts presentation content from the resolved source.',
  systemPrompt:
    'You are a presentation drafting agent. Generate the deck content from the provided source, audience, tone, and goal.',
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const renderAgent = defineAgent({
  id: 'presentation-render',
  description: 'Renders the approved deck into a branded Gamma presentation.',
  systemPrompt:
    'You are a Gamma render agent. Render the approved deck content into a branded Gamma presentation.',
  tools: [],
  capabilities: canonicalizeToolNames(['gamma_create_from_template']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const kind = 'presentation-generation';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    template: step({ agent: templateAgent }),
    source: step({ agent: sourceAgent, after: ['template'] }),
    generate: step({ agent: generateAgent, after: ['source'] }),
    review: awaitSignal({ name: 'review-approval', after: ['generate'] }),
    render: step({ agent: renderAgent, after: ['review'] }),
  },
});
