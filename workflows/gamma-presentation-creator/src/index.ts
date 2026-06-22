import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import {
  canonicalizeToolNames,
  deterministicToolStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from '@workbench/agents';
import {
  PRESENTATION_GENERATE_SYSTEM_PROMPT,
  PRESENTATION_REVIEW_SYSTEM_PROMPT,
} from './prompts';

const generateAgent = defineAgent({
  id: 'presentation-generate',
  description: 'Drafts presentation content from the resolved source.',
  systemPrompt: PRESENTATION_GENERATE_SYSTEM_PROMPT,
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create', 'write_artifact']),
  inference: {
    sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const reviewAgent = defineAgent({
  id: 'presentation-brand-review',
  description: 'Tightens generated slide content before human review and Gamma rendering.',
  systemPrompt: PRESENTATION_REVIEW_SYSTEM_PROMPT,
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'Gamma Presentation Creator';
export const description =
  'Generate a polished Gamma presentation from a topic, audience, and key points.';
export const kind = 'gamma-presentation-creator';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    'list-templates': deterministicToolStep({
      id: 'presentation-list-templates',
      tool: 'gamma_list_templates',
    }),
    template: awaitSignal({ name: 'template', after: ['list-templates'] }),
    'list-notes': deterministicToolStep({
      id: 'presentation-list-notes',
      tool: 'granola_list_notes',
      after: ['template'],
    }),
    'source-selection': awaitSignal({
      name: 'source-selection',
      after: ['list-notes'],
    }),
    source: deterministicToolStep({
      id: 'presentation-source',
      tool: 'granola_get_note',
      input: { from: 'steps.source-selection.output' },
      after: ['source-selection'],
    }),
    generate: step({
      agent: generateAgent,
      after: ['source'],
      input: {
        merge: [{ from: 'steps.template.output' }, { from: 'steps.source.output' }],
      },
    }),
    'brand-review': step({
      agent: reviewAgent,
      after: ['generate'],
      input: { from: 'steps.generate.output' },
    }),
    review: awaitSignal({ name: 'review-approval', after: ['brand-review'] }),
    // Deterministic tool call. `gamma_create_from_template` requires
    // { gammaId, prompt }; the argMap renames the merged upstream fields to
    // the tool's arg names: `gammaId` from the template form payload and
    // `prompt` from the brand-review agent's `reply`. No inference needed.
    render: deterministicToolStep({
      id: 'presentation-render',
      tool: 'gamma_create_from_template',
      input: {
        merge: [{ from: 'steps.template.output' }, { from: 'steps.brand-review.output' }],
      },
      argMap: {
        gammaId: { from: 'gammaId' },
        prompt: { from: 'reply' },
      },
      after: ['review'],
    }),
  },
});
