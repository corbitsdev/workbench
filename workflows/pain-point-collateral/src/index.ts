import { action, awaitSignal, defineWorkflow, map } from "@intx/workflow";
import {
  canonicalizeStepToolName,
  deterministicToolStep,
  agentStep,
} from "@workbench/agents";
import {
  buildCollateralGenerationSystemPrompt,
  buildExtractionSystemPrompt,
} from "./prompts";

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "pain-point-collateral-intake",
  "granola_list_notes",
);
export const GRANOLA_GET_NOTE_HANDLER = canonicalizeStepToolName(
  "pain-point-collateral-fetch",
  "granola_get_note",
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

const generateStep = agentStep({
  id: "pain-point-collateral-generate",
  title: "Draft each piece",
  systemPrompt: buildCollateralGenerationSystemPrompt(),
  // trigger.payload = one {format, painPointId, painPointTitle, painPointDetail, severity} item
  // The UI pre-computes the cartesian product (max 3 pain points × 3 formats = 9 items) and
  // embeds all LLM-needed data in each item — no merge needed.
  input: { from: "trigger.payload" },
});

// NOT migrated to a native `action` — two independent blockers, either one
// sufficient on its own:
//   1. Field rename: `artifact_create` requires `kind`, but the map item
//      carries the same value under `format`. The native selector vocabulary
//      (`from` / `project` / `merge` / `literal`) can only pick fields
//      through, never rename one — `project` keeps the source field's own
//      name, and there is no selector shape that writes a value under a
//      different key. Composing `title`/`content` (pass through unrenamed)
//      with `kind` (renamed from `format`) into one object is therefore not
//      expressible as a single `input` selector.
//   2. `MapPrimitive.step` is typed `StepPrimitive` (see
//      `@intx/workflow`'s `primitives.ts`), not `Primitive` — an `action`
//      cannot be a map's inner step at all. Independently, the deploy-time
//      capability walk's `extractAgent` only reads `primitive.step.agent` for
//      a `map` node (see `interchange/packages/workflow-deploy/src/
//      capability-walk.ts`); it never inspects an inner step's `effect`, so
//      even a same-shape action inside a map would pin no tool package.
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

    // 10. Create one artifact per approved piece (sequential map)
    persist: map({
      over: { from: "steps.review.output.approvedPieces" },
      step: persistStep,
      after: ["review"],
    }),
  },
});
