import { awaitSignal, defineWorkflow, map } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import {
  buildCollateralGenerationSystemPrompt,
  buildExtractionSystemPrompt,
} from "./prompts";

// -------------------------------------------------------------------------
// Agent definitions
// -------------------------------------------------------------------------

// `analyze` and `generate` are pure single-turn reasoning steps: each returns
// strict JSON and never calls a tool (the deterministic `persist` step does the
// artifact creation). Both run as inline-inference steps (CL-2251): the sidecar
// runs them in-process with a bare `createAgent` and the hub deploys no per-step
// session for them. See the `analyze` and `generate` steps below — there are no
// longer analyze/generate defineAgents.

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = "Pain Point Collateral Generation";
export const description =
  "Analyze a call transcript for customer pain points and generate targeted sales collateral.";
export const kind = "pain-point-collateral";

// -------------------------------------------------------------------------
// Workflow definition — 8-step guided flow
//
// Step graph:
//   intake       deterministicToolStep  granola_list_notes → {}
//   select       awaitSignal            note-selection      → {noteId}
//   fetch        deterministicToolStep  granola_get_note    input from steps.select.output
//   context      awaitSignal            context             → {context: string}
//   analyze      inlineInferenceStep    input merge fetch+context outputs
//   ppSelection  awaitSignal            pain-point-selection → {selectedIds: string[]}
//   fmtSelection awaitSignal            format-selection    → {items: Array<{format,painPointId,...}>}
//   generate     map over fmtSelection.output.items (max 9: 3 pain points × 3 formats)
//     └ inlineInferenceStep input from trigger.payload only (item carries all LLM-needed data)
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

const generateStep = inlineInferenceStep({
  id: "pain-point-collateral-generate",
  title: "Draft each piece",
  systemPrompt: buildCollateralGenerationSystemPrompt(),
  // trigger.payload = one {format, painPointId, painPointTitle, painPointDetail, severity} item
  // The UI pre-computes the cartesian product (max 3 pain points × 3 formats = 9 items) and
  // embeds all LLM-needed data in each item — no merge needed.
  input: { from: "trigger.payload" },
});

const persistStep = deterministicToolStep({
  id: "pain-point-collateral-persist",
  title: "Save the collateral",
  tool: "artifact_create",
  // map passes each approved item as `trigger.payload` ({format, title,
  // content}); point the step input at it so the argMap fields resolve.
  input: { from: "trigger.payload" },
  argMap: {
    title: { from: "title" },
    kind: { from: "format" },
    content: { from: "content" },
  },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Fetch the Granola note list
    intake: deterministicToolStep({
      id: "pain-point-collateral-intake",
      title: "List your call notes",
      tool: "granola_list_notes",
      input: { literal: {} },
    }),

    // 2. Human selects a note
    select: awaitSignal({ name: "note-selection", after: ["intake"] }),

    // 3. Fetch selected note transcript
    fetch: deterministicToolStep({
      id: "pain-point-collateral-fetch",
      title: "Load the chosen note",
      tool: "granola_get_note",
      input: { from: "steps.select.output" },
      after: ["select"],
    }),

    // 4. Human adds context
    context: awaitSignal({ name: "context", after: ["fetch"] }),

    // 5. LLM extracts pain points (input = fetched transcript + user context merged).
    //    Inline single-turn inference (CL-2251): no tools, so no per-step session.
    analyze: inlineInferenceStep({
      id: "pain-point-collateral-analyze",
      title: "Find the pain points",
      systemPrompt: buildExtractionSystemPrompt(),
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.context.output" },
        ],
      },
      after: ["context"],
    }),

    // 6. Human selects which pain points to address
    ppSelection: awaitSignal({
      name: "pain-point-selection",
      after: ["analyze"],
    }),

    // 7. Human selects output formats — payload: {formats: Array<{format: string}>}
    fmtSelection: awaitSignal({
      name: "format-selection",
      after: ["ppSelection"],
    }),

    // 8. Generate one collateral piece per (pain point × format) item, capped at 9
    generate: map({
      over: { from: "steps.fmtSelection.output.items" },
      step: generateStep,
      after: ["fmtSelection"],
    }),

    // 9. Human approves/denies each piece; panel sends all decisions plus
    //    approvedPieces for persistence.
    review: awaitSignal({ name: "review", after: ["generate"] }),

    // 10. Create one artifact per approved piece (sequential map)
    persist: map({
      over: { from: "steps.review.output.approvedPieces" },
      step: persistStep,
      after: ["review"],
    }),
  },
});
