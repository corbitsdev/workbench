import { action, awaitSignal, defineWorkflow, map } from "@intx/workflow";
import { canonicalizeStepToolName, agentStep } from "@workbench/agents";
import {
  buildCollateralGenerationSystemPrompt,
  buildExtractionSystemPrompt,
} from "./prompts";

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "pain-point-collateral-intake",
  "granola_list_notes",
);
export const GRANOLA_GET_NOTE_HANDLER = canonicalizeStepToolName(
  "pain-point-collateral-fetch",
  "granola_get_note",
);
export const PERSIST_PIECES_HANDLER = canonicalizeStepToolName(
  "pain-point-collateral-persist",
  "pain_point_collateral_persist_pieces",
);

// -------------------------------------------------------------------------
// Agent definitions
// -------------------------------------------------------------------------

// `analyze` and `generate` are pure single-turn reasoning steps: each returns
// strict JSON and never calls a tool (the deterministic `persist` step does the
// artifact creation). Both are native `agentStep`s — a plain `step({ agent })`
// the hub deploys no per-step session for (no step class launches one). See
// the `analyze` and `generate` steps below — there are no longer
// analyze/generate defineAgents.

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = "Pain Point Collateral Generation";
export const description =
  "Analyze a call transcript for customer pain points and generate targeted sales collateral.";
export const kind = "pain-point-collateral";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// -------------------------------------------------------------------------
// Workflow definition — 8-step guided flow
//
// Step graph:
//   intake       action                 granola_list_notes → {} (native primitive)
//   select       awaitSignal            note-selection      → {noteId}
//   fetch        action                 granola_get_note    input from steps.select.output (native primitive)
//   context      awaitSignal            context             → {context: string}
//   analyze      agentStep    input merge fetch+context outputs
//   ppSelection  awaitSignal            pain-point-selection → {selectedIds: string[]}
//   fmtSelection awaitSignal            format-selection    → {items: Array<{format,painPointId,...}>}
//   generate     map over fmtSelection.output.items (max 9: 3 pain points × 3 formats)
//     └ agentStep input from trigger.payload only (item carries all LLM-needed data)
//   review       awaitSignal            review              → {decisions: Array<{format,title,content}>}
//                                       (panel sends ONLY approved pieces)
//   persist      action  artifact_create batch tool  over review.output.decisions
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

const generateStep = agentStep({
  id: "pain-point-collateral-generate",
  title: "Draft each piece",
  systemPrompt: buildCollateralGenerationSystemPrompt(),
  // trigger.payload = one {format, painPointId, painPointTitle, painPointDetail, severity} item
  // The UI pre-computes the cartesian product (max 3 pain points × 3 formats = 9 items) and
  // embeds all LLM-needed data in each item — no merge needed.
  input: { from: "trigger.payload" },
});

// Folded from a `map` of single-piece `deterministicToolStep`s into one
// native `action`: `pain_point_collateral_persist_pieces` loops over
// `approvedPieces` in-process, doing the `format` → `kind` field rename
// itself (see `persist-tool.ts` for the two independent blockers that ruled
// out a plain same-shape action inside the old map: the field rename no
// selector can express, and `MapPrimitive.step`'s `StepPrimitive`-only
// typing). Fatal by design (unchanged from the old map): any failed save
// fails the run. Folding N per-item steps into one action means a crash
// mid-save now re-runs the WHOLE batch on resume instead of resuming after
// the already-saved pieces — a real checkpointing change from the old
// per-item map, acceptable given an approved batch is capped small (max 9
// pain-point × format combinations).

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Fetch the Granola note list. Native `action`: the tool takes no
    // required args, so `input: { literal: {} }` is the whole call — no
    // reshape needed.
    intake: action({
      handler: GRANOLA_LIST_NOTES_HANDLER,
      input: { literal: {} },
      effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
    }),

    // 2. Human selects a note
    select: awaitSignal({ name: "note-selection", after: ["intake"] }),

    // 3. Fetch selected note transcript. Native `action`: `select`'s signal
    // payload is already shaped `{ noteId }`, matching `granola_get_note`'s
    // sole arg — passed through verbatim, no reshape needed.
    fetch: action({
      handler: GRANOLA_GET_NOTE_HANDLER,
      input: { from: "steps.select.output" },
      effect: { requires: [GRANOLA_GET_NOTE_HANDLER] },
      after: ["select"],
    }),

    // 4. Human adds context
    context: awaitSignal({ name: "context", after: ["fetch"] }),

    // 5. LLM extracts pain points (input = fetched transcript + user context merged).
    //    Inline single-turn inference (CL-2251): no tools, so no per-step session.
    analyze: agentStep({
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

    // 10. Save every approved piece — one native action, batched internally.
    persist: action({
      handler: PERSIST_PIECES_HANDLER,
      input: { from: "steps.review.output" },
      effect: { requires: [PERSIST_PIECES_HANDLER] },
      after: ["review"],
    }),
  },
});
