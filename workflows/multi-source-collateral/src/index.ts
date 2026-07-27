import {
  action,
  awaitSignal,
  defineWorkflow,
  gate,
  map,
  step,
} from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import { buildGenerationSystemPrompt } from "./prompts";

export const label = "Multi-Source Collateral";
export const description =
  "Choose mixed sources (artifacts, Granola notes, Linear tickets, free text), pick content types, generate pieces, swipe review with optional feedback regenerate, and save approved artifacts.";
export const kind = "multi-source-collateral";

export { DISPLAY_STEPS } from "./display-steps";
export { STEP_UI } from "./step-ui";
export {
  CONTENT_TYPES,
  MAX_CONTENT_TYPES,
  defaultPromptForType,
} from "./prompts";

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Formerly `LLM_WRITER_MODEL`/`LLM_PROVIDER` from `@workbench/agents`.
const WRITER_MODEL = "kimi-k2.6";
const LLM_PROVIDER = "openai-compatible";

// Corbits terminology guidance every reasoning step's system prompt carries.
// Formerly applied automatically by `@workbench/agents`' `agentStep` sugar;
// inlined here as a plain string join, mirroring sumble-account-intel's own
// local copy.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

/** Inlined `agentStep` replacement: a native reasoning-with-tools step (a
 * plain `step({ agent })` built from `defineAgent`), no `@workbench/agents`
 * dependency. */
function reasoningStep(opts: { id: string; title: string }): StepPrimitive {
  const agent = defineAgent({
    id: opts.id,
    description: `Reasoning step: ${opts.id}`,
    systemPrompt: [CORBITS_VOCABULARY, buildGenerationSystemPrompt()].join(
      "\n\n",
    ),
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: LLM_PROVIDER, model: WRITER_MODEL }],
    },
    tags: { [STEP_TITLE_TAG]: opts.title },
  });
  return step({ agent, input: { from: "trigger.payload" } });
}

// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, checked against the committed tool manifest by a repo-level test
// (`packages/tool-manifest/src/resolvable-handlers.test.ts`), so a typo'd or
// manifest-drifted handler string fails the build instead of deploying a
// step nothing can dispatch.
export const ARTIFACT_LIST_HANDLER =
  "@workbench/tools-artifact/artifact:artifact_list";
export const GRANOLA_LIST_NOTES_HANDLER =
  "@workbench/tools-granola/granola:granola_list_notes";
export const LIST_ISSUES_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_list_issues";
// Real Linear tool name — never dispatched (the wrapper calls it in-process),
// but declared in list-issues' effect.requires so the deploy capability walk
// pins @workbench/tools-linear, whose manifest carries the `linear` provider
// this workflow's wrapper package cannot claim (providerName: null). Without
// the pin the credential route 403s the whole batch. Same pattern as
// last30days-research / heartbeat.
export const LINEAR_LIST_ISSUES_HANDLER =
  "@workbench/tools-linear/linear:linear_list_issues";
export const PREPARE_SOURCES_GATE_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_prepare_sources_gate";
export const FETCH_SOURCES_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_fetch_sources";
export const PREPARE_OPTIONS_GATE_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_prepare_options_gate";
export const BUILD_GENERATE_ITEMS_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_build_generate_items";
export const PREPARE_REVIEW_GATE_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_prepare_review_gate";
export const PREPARE_REVIEW_FINAL_GATE_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_prepare_review_final_gate";
export const PREPARE_REGENERATE_ITEMS_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_prepare_regenerate_items";
export const PERSIST_PIECES_HANDLER =
  "@workbench/workflow-multi-source-collateral/core:multi_source_collateral_persist_pieces";

// ---------------------------------------------------------------------------
// Step graph
//
// list-artifacts | list-notes | list-issues  (parallel roots)
//   → prepareSourcesGate (shapes into the `sources` gate's form UIBlock)
//   → sources awaitSignal            { sourceIds, freeText }
// fetchSources    (folds the former per-kind fetch maps into one tool)
//   → prepareOptionsGate (shapes into the `options` gate's form UIBlock)
//   → options awaitSignal            { contentTypes, audience?, tone?, ... }
// buildGenerateItems → generate map (one reasoning turn per content type)
//   → prepareReviewGate (shapes into the `review` gate's reviewList UIBlock)
//   → review awaitSignal             { approvedPieces, decisions }
// prepareRegenerateItems → regenerateGate
//   then: regenerate map → prepareReviewFinalGate → review-final awaitSignal
//         → persist-after-regen
//   else: persist (over review's approvedPieces)
// ---------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Native `action`: artifact_list's arktype schema is { kind?, limit? },
    // so a literal { limit: 50 } is the exact argument object verbatim — no
    // reshape needed.
    "list-artifacts": action({
      handler: ARTIFACT_LIST_HANDLER,
      input: { literal: { limit: 50 } },
      effect: { requires: [ARTIFACT_LIST_HANDLER] },
    }),

    // Native `action`: granola_list_notes takes limit/cursor/date filters,
    // all optional, so a literal { limit: 30 } is the exact argument object
    // verbatim — no reshape needed.
    "list-notes": action({
      handler: GRANOLA_LIST_NOTES_HANDLER,
      input: { literal: { limit: 30 } },
      effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
    }),

    // Linear may be unconfigured; that must not fail the multi-source
    // chooser. Native `action` has no `nonFatal` error-swallow, so the
    // tolerance moves into the wrapper tool itself (see tools.ts): it calls
    // `linear_list_issues` in-process and returns a completed envelope on
    // failure instead of throwing.
    "list-issues": action({
      handler: LIST_ISSUES_HANDLER,
      input: { literal: { first: 50 } },
      effect: { requires: [LIST_ISSUES_HANDLER, LINEAR_LIST_ISSUES_HANDLER] },
    }),

    // Shapes the three list steps' output into the `form` UIBlock the
    // `sources` gate's STEP_UI entry renders via gateFromOutput. Fatal — a
    // malformed prior step's output here is a genuine wiring bug, not a
    // best-effort data source (each input list already tolerates empty).
    prepareSourcesGate: action({
      handler: PREPARE_SOURCES_GATE_HANDLER,
      input: {
        merge: [
          { from: "steps.list-artifacts.output" },
          { from: "steps.list-notes.output" },
          { from: "steps.list-issues.output" },
        ],
      },
      effect: { requires: [PREPARE_SOURCES_GATE_HANDLER] },
      after: ["list-artifacts", "list-notes", "list-issues"],
    }),

    sources: awaitSignal({ name: "sources", after: ["prepareSourcesGate"] }),

    // Folds the former fetch-artifacts/fetch-notes/fetch-issues `map`s into
    // one tool: `MapPrimitive.step` is a `StepPrimitive`, and an `action`
    // cannot be a map's inner step at all (the deploy capability walk only
    // reads `primitive.step.agent` for a map node) — see tools.ts. Fatal: a
    // failed fetch for any SELECTED source fails the run, matching the
    // originals' deterministic-tool-step semantics (no `nonFatal` was ever
    // set on them).
    fetchSources: action({
      handler: FETCH_SOURCES_HANDLER,
      input: { from: "steps.sources.output" },
      effect: { requires: [FETCH_SOURCES_HANDLER] },
      after: ["sources"],
    }),

    // Shapes the fetched source-context into the `form` UIBlock the
    // `options` gate's STEP_UI entry renders via gateFromOutput.
    prepareOptionsGate: action({
      handler: PREPARE_OPTIONS_GATE_HANDLER,
      input: { from: "steps.fetchSources.output" },
      effect: { requires: [PREPARE_OPTIONS_GATE_HANDLER] },
      after: ["fetchSources"],
    }),

    options: awaitSignal({ name: "options", after: ["prepareOptionsGate"] }),

    // Combines the fetched source context with the picked content
    // types/options into one generate payload per selected content type.
    buildGenerateItems: action({
      handler: BUILD_GENERATE_ITEMS_HANDLER,
      input: {
        merge: [
          { from: "steps.fetchSources.output" },
          { from: "steps.options.output" },
        ],
      },
      effect: { requires: [BUILD_GENERATE_ITEMS_HANDLER] },
      after: ["fetchSources", "options"],
    }),

    generate: map({
      over: { from: "steps.buildGenerateItems.output.items" },
      step: reasoningStep({
        id: "multi-source-collateral-generate",
        title: "Draft each piece",
      }),
      after: ["buildGenerateItems"],
    }),

    // Shapes the generate map's output into the `reviewList` UIBlock the
    // `review` gate's STEP_UI entry renders via gateFromOutput.
    prepareReviewGate: action({
      handler: PREPARE_REVIEW_GATE_HANDLER,
      input: { from: "steps.generate.output" },
      effect: { requires: [PREPARE_REVIEW_GATE_HANDLER] },
      after: ["generate"],
    }),

    review: awaitSignal({ name: "review", after: ["prepareReviewGate"] }),

    // Reads the review gate's per-row decisions plus the (single, shared)
    // source context to build one regenerate payload per rejected piece.
    prepareRegenerateItems: action({
      handler: PREPARE_REGENERATE_ITEMS_HANDLER,
      input: {
        merge: [
          { from: "steps.review.output" },
          { from: "steps.fetchSources.output" },
        ],
      },
      effect: { requires: [PREPARE_REGENERATE_ITEMS_HANDLER] },
      after: ["review"],
    }),

    // shouldRegenerate is a boolean on prepareRegenerateItems' output.
    regenerateGate: gate({
      when: { from: "steps.prepareRegenerateItems.output.shouldRegenerate" },
      then: "regenerate",
      else: "persist",
      after: ["prepareRegenerateItems"],
    }),

    regenerate: map({
      over: { from: "steps.prepareRegenerateItems.output.regenerateItems" },
      step: reasoningStep({
        id: "multi-source-collateral-regenerate",
        title: "Revise with feedback",
      }),
      after: ["regenerateGate"],
    }),

    prepareReviewFinalGate: action({
      handler: PREPARE_REVIEW_FINAL_GATE_HANDLER,
      input: { from: "steps.regenerate.output" },
      effect: { requires: [PREPARE_REVIEW_FINAL_GATE_HANDLER] },
      after: ["regenerate"],
    }),

    "review-final": awaitSignal({
      name: "review-final",
      after: ["prepareReviewFinalGate"],
    }),

    "persist-after-regen": action({
      handler: PERSIST_PIECES_HANDLER,
      input: { from: "steps.review-final.output" },
      effect: { requires: [PERSIST_PIECES_HANDLER] },
      after: ["review-final"],
    }),

    persist: action({
      handler: PERSIST_PIECES_HANDLER,
      input: { from: "steps.review.output" },
      effect: { requires: [PERSIST_PIECES_HANDLER] },
      after: ["regenerateGate"],
    }),
  },
});
