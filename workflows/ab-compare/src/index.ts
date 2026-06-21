import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, step } from '@intx/workflow';
import { deterministicToolStep, LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';

const executeAgent = defineAgent({
  id: 'blind-ab-execute',
  description: 'Runs the shared prompt across each selected provider branch.',
  systemPrompt:
    'You are an execution agent. You receive a JSON payload with a `prompt` field. ' +
    'Run the prompt and return the result verbatim. ' +
    'Do not editorialize or summarize — output exactly what the prompt produces.',
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const compareAgent = defineAgent({
  id: 'blind-ab-compare',
  description: 'Blind-ranks the provider outputs and prepares them for human review.',
  systemPrompt:
    'You are a comparison agent. You receive the output of the execution step. ' +
    'Produce a blind ranking of the content variants from best to worst. ' +
    'You MUST respond with ONLY a JSON object — no prose, no markdown fences — ' +
    'in this exact shape: ' +
    '{ "summary": "<one sentence>", "ranking": [{ "rank": 1, "label": "Variant N", "rationale": "<reason>" }] }',
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'A/B Compare';
export const description =
  'Run two content variants through a blind comparison and surface ranked results.';
export const kind = 'ab-compare';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    // Step 1: collect the shared prompt from the user.
    // Payload: { prompt: string }
    input: awaitSignal({ name: 'input' }),

    // Step 2: execute the prompt (single-agent — no map; dynamic multi-variant
    // fan-out requires a runtime array selector that the substrate does not yet
    // expose from an awaitSignal payload). The agent receives the raw signal
    // payload and produces output for blind ranking.
    execute: step({
      agent: executeAgent,
      input: { from: 'steps.input.output' },
      after: ['input'],
    }),

    // Step 3: blind-rank the execution output.
    compare: step({
      agent: compareAgent,
      input: { from: 'steps.execute.output' },
      after: ['execute'],
    }),

    // Step 4: human reviews the ranking and approves.
    // Payload: { approved: true }
    review: awaitSignal({ name: 'comparison-review', after: ['compare'] }),

    // Step 5: deterministic artifact_create — saves the comparison result.
    // The compare agent's `reply` (strict JSON) becomes the artifact content.
    persist: deterministicToolStep({
      id: 'blind-ab-persist',
      tool: 'artifact_create',
      input: { from: 'steps.compare.output' },
      argMap: {
        content: { from: 'reply' },
        title: { literal: 'A/B Comparison Results' },
        kind: { literal: 'document' },
      },
      after: ['review'],
    }),
  },
});
