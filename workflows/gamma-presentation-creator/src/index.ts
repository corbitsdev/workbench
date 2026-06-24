import { awaitSignal, defineWorkflow } from '@intx/workflow';
import { deterministicToolStep, inlineInferenceStep } from '@workbench/agents';
import { PRESENTATION_GENERATE_SYSTEM_PROMPT, PRESENTATION_REVIEW_SYSTEM_PROMPT } from './prompts';

// `generate` and `brand-review` are pure single-turn reasoning steps: each
// returns slide content directly and never calls a tool (the deterministic
// `render` step does the Gamma render). `generate` previously declared
// `artifact_create`/`write_artifact` capabilities, but its prompt only emits
// SLIDE N: text — those caps were vestigial and are dropped. Both run as
// inline-inference steps (CL-2251): the sidecar runs them in-process with a bare
// `createAgent` and the hub deploys no per-step session.

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
    generate: inlineInferenceStep({
      id: 'presentation-generate',
      systemPrompt: PRESENTATION_GENERATE_SYSTEM_PROMPT,
      after: ['source'],
      input: {
        merge: [{ from: 'steps.template.output' }, { from: 'steps.source.output' }],
      },
    }),
    'brand-review': inlineInferenceStep({
      id: 'presentation-brand-review',
      systemPrompt: PRESENTATION_REVIEW_SYSTEM_PROMPT,
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
