import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, map, step } from '@intx/workflow';
import {
  canonicalizeToolNames,
  deterministicToolStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from '@workbench/agents';

// -------------------------------------------------------------------------
// Agent definitions
// -------------------------------------------------------------------------

const analyzeAgent = defineAgent({
  id: 'pain-point-collateral-analyze',
  description: 'Extracts pain points from a call transcript plus caller-supplied context.',
  systemPrompt: [
    'You are a pain-point extraction agent.',
    'You will receive the full transcript of a customer call and any additional context the user has provided.',
    'Extract every distinct customer pain point you identify.',
    'Output STRICT JSON ONLY — no prose, no markdown fences — matching this shape exactly:',
    '{"painPoints":[{"id":"pp1","title":"<short label>","detail":"<one sentence explanation>"}]}',
    'Use short sequential ids: pp1, pp2, etc.',
  ].join('\n'),
  tools: [],
  capabilities: [],
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

const generateAgent = defineAgent({
  id: 'pain-point-collateral-generate',
  description:
    'Generates one piece of sales collateral for a given format and selected pain points.',
  systemPrompt: [
    'You are a sales collateral generation agent.',
    'You will receive a collateral format (e.g. "Email", "One-pager", "LinkedIn post") and a list of selected pain points.',
    'Write ONE piece of collateral in the requested format that addresses those pain points.',
    'Output STRICT JSON ONLY — no prose, no markdown fences — matching this shape exactly:',
    '{"format":"<format name>","title":"<collateral title>","content":"<full collateral body>"}',
  ].join('\n'),
  tools: [],
  capabilities: canonicalizeToolNames(['artifact_create']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = 'Collateral Generation';
export const description =
  'Analyze a call transcript for customer pain points and generate targeted sales collateral.';
export const kind = 'pain-point-collateral';

// -------------------------------------------------------------------------
// Workflow definition — 8-step guided flow
//
// Step graph:
//   intake       deterministicToolStep  granola_list_notes → {}
//   select       awaitSignal            note-selection      → {noteId}
//   fetch        deterministicToolStep  granola_get_note    input from steps.select.output
//   context      awaitSignal            context             → {context: string}
//   analyze      step(analyzeAgent)     input merge fetch+context outputs
//   ppSelection  awaitSignal            pain-point-selection → {selectedIds: string[]}
//   fmtSelection awaitSignal            format-selection    → {formats: Array<{format: string}>}
//   generate     map over fmtSelection.output.formats
//     └ step(generateAgent) input merge trigger.payload + analyze + ppSelection outputs
//   review       awaitSignal            review              → {decisions: Array<{format,title,content}>}
//                                       (panel sends ONLY approved pieces)
//   persist      map over review.output.decisions
//     └ deterministicToolStep artifact_create argMap {title, kind, content}
//
// Deviation from spec step 6 (parallel map):
//   The interchange `map` primitive runs iterations SEQUENTIALLY (v1 runtime).
//   The spec calls for "parallel" fan-out, but the only map available is sequential.
//   We use `map` anyway — the semantics are correct; only the concurrency differs.
//   Filed for resolution when the runtime adds parallel fan-out.
//
// Deviation from spec step 7 (filter approved in map):
//   There is no filter/gate primitive inside a map. Instead, the panel sends
//   `review` signal payload containing ONLY the approved pieces (it filters
//   client-side before firing). The persist map therefore creates one artifact
//   per entry unconditionally.
// -------------------------------------------------------------------------

const generateStep = step({
  agent: generateAgent,
  // trigger.payload = {format: string} (one item from fmtSelection array)
  // merge brings format + pain-point extraction + selected ids together
  input: {
    merge: [
      { from: 'trigger.payload' },
      { from: 'steps.analyze.output' },
      { from: 'steps.ppSelection.output' },
    ],
  },
});

const persistStep = deterministicToolStep({
  id: 'pain-point-collateral-persist',
  tool: 'artifact_create',
  // map passes each approved item as `trigger.payload` ({format, title,
  // content}); point the step input at it so the argMap fields resolve.
  input: { from: 'trigger.payload' },
  argMap: {
    title: { from: 'title' },
    kind: { literal: 'document' },
    content: { from: 'content' },
  },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    // 1. Fetch the Granola note list
    intake: deterministicToolStep({
      id: 'pain-point-collateral-intake',
      tool: 'granola_list_notes',
      input: { literal: {} },
    }),

    // 2. Human selects a note
    select: awaitSignal({ name: 'note-selection', after: ['intake'] }),

    // 3. Fetch selected note transcript
    fetch: deterministicToolStep({
      id: 'pain-point-collateral-fetch',
      tool: 'granola_get_note',
      input: { from: 'steps.select.output' },
      after: ['select'],
    }),

    // 4. Human adds context
    context: awaitSignal({ name: 'context', after: ['fetch'] }),

    // 5. LLM extracts pain points (input = fetched transcript + user context merged)
    analyze: step({
      agent: analyzeAgent,
      input: {
        merge: [{ from: 'steps.fetch.output' }, { from: 'steps.context.output' }],
      },
      after: ['context'],
    }),

    // 6. Human selects which pain points to address
    ppSelection: awaitSignal({ name: 'pain-point-selection', after: ['analyze'] }),

    // 7. Human selects output formats — payload: {formats: Array<{format: string}>}
    fmtSelection: awaitSignal({ name: 'format-selection', after: ['ppSelection'] }),

    // 8. Generate one collateral piece per format (sequential map; see deviation note)
    generate: map({
      over: { from: 'steps.fmtSelection.output.formats' },
      step: generateStep,
      after: ['fmtSelection'],
    }),

    // 9. Human approves/denies each piece; panel sends ONLY approved in payload
    //    payload: {decisions: Array<{format: string, title: string, content: string}>}
    review: awaitSignal({ name: 'review', after: ['generate'] }),

    // 10. Create one artifact per approved piece (sequential map)
    persist: map({
      over: { from: 'steps.review.output.decisions' },
      step: persistStep,
      after: ['review'],
    }),
  },
});
