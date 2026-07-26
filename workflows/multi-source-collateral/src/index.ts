import { action, awaitSignal, defineWorkflow, gate, map } from "@intx/workflow";
import { canonicalizeStepToolName, agentStep } from "@workbench/agents";
import { buildGenerationSystemPrompt } from "./prompts";

export const label = "Multi-Source Collateral";
export const description =
  "Choose mixed sources (artifacts, Granola notes, Linear tickets, free text), pick content types, generate pieces, swipe review with optional feedback regenerate, and save approved artifacts.";
export const kind = "multi-source-collateral";

export { DISPLAY_STEPS } from "./display-steps";
export {
  CONTENT_TYPES,
  MAX_CONTENT_TYPES,
  defaultPromptForType,
} from "./prompts";

// Native `action` handler refs for the two root list steps that are not a
// map's inner step — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const ARTIFACT_LIST_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-list-artifacts",
  "artifact_list",
);
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-list-notes",
  "granola_list_notes",
);
export const LIST_ISSUES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-list-issues",
  "multi_source_collateral_list_issues",
);
export const FETCH_ARTIFACTS_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-fetch-artifacts",
  "multi_source_collateral_fetch_artifacts",
);
export const FETCH_NOTES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-fetch-notes",
  "multi_source_collateral_fetch_notes",
);
export const FETCH_ISSUES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-fetch-issues",
  "multi_source_collateral_fetch_issues",
);
export const PERSIST_PIECES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-persist",
  "multi_source_collateral_persist_pieces",
);

// ---------------------------------------------------------------------------
// Step graph
//
// list-artifacts | list-notes | list-issues  (parallel roots)
//   → sources awaitSignal
// fetch-artifacts | fetch-notes | fetch-issues  (actions; empty arrays are no-ops)
//   → options awaitSignal  { items: generate payloads }
// generate map
//   → review awaitSignal  { approvedPieces, shouldRegenerate, regenerateItems }
// regenerateGate
//   then: regenerate map → review-final → persist-after-regen
//   else: persist over review.approvedPieces
// ---------------------------------------------------------------------------

const generateStep = agentStep({
  id: "multi-source-collateral-generate",
  title: "Draft each piece",
  systemPrompt: buildGenerationSystemPrompt(),
  input: { from: "trigger.payload" },
});

const regenerateStep = agentStep({
  id: "multi-source-collateral-regenerate",
  title: "Revise with feedback",
  systemPrompt: buildGenerationSystemPrompt(),
  input: { from: "trigger.payload" },
});

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

    // Native `action`: granola_list_notes takes limit/cursor/date filters, all
    // optional, so a literal { limit: 30 } is the exact argument object
    // verbatim — no reshape needed.
    "list-notes": action({
      handler: GRANOLA_LIST_NOTES_HANDLER,
      input: { literal: { limit: 30 } },
      effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
    }),

    // Linear may be unconfigured; that must not fail the multi-source
    // chooser. Native `action` has no `nonFatal` error-swallow, so
    // the tolerance moves into the wrapper tool itself (see
    // `list-issues-tool.ts`): it calls `linear_list_issues` in-process and
    // returns a completed envelope on failure instead of throwing.
    "list-issues": action({
      handler: LIST_ISSUES_HANDLER,
      input: { literal: { first: 50 } },
      effect: { requires: [LIST_ISSUES_HANDLER] },
    }),

    sources: awaitSignal({
      name: "sources",
      after: ["list-artifacts", "list-notes", "list-issues"],
    }),

    // Folded from a `map` of single-item `deterministicToolStep`s into one
    // native `action` per source type: `multi_source_collateral_fetch_*`
    // loops over its own items array in-process (see `fetch-tools.ts`),
    // since a map's inner step can't be a native `action` at all. Each
    // action's whole input is `steps.sources.output` (which carries
    // `artifactItems`/`noteItems`/`issueItems`/`text`); each tool reads only
    // the one array field it owns. Fatal by design (unchanged from the old
    // map): any failed fetch fails the run. One consequence of folding N
    // per-item steps into one action: a crash mid-fetch now re-runs the
    // WHOLE batch on resume instead of resuming after the already-fetched
    // items — acceptable here since a fetch batch is small and fast, but a
    // real behavior change from the old per-item map checkpointing.
    "fetch-artifacts": action({
      handler: FETCH_ARTIFACTS_HANDLER,
      input: { from: "steps.sources.output" },
      effect: { requires: [FETCH_ARTIFACTS_HANDLER] },
      after: ["sources"],
    }),

    "fetch-notes": action({
      handler: FETCH_NOTES_HANDLER,
      input: { from: "steps.sources.output" },
      effect: { requires: [FETCH_NOTES_HANDLER] },
      after: ["sources"],
    }),

    "fetch-issues": action({
      handler: FETCH_ISSUES_HANDLER,
      input: { from: "steps.sources.output" },
      effect: { requires: [FETCH_ISSUES_HANDLER] },
      after: ["sources"],
    }),

    options: awaitSignal({
      name: "options",
      after: ["fetch-artifacts", "fetch-notes", "fetch-issues"],
    }),

    generate: map({
      over: { from: "steps.options.output.items" },
      step: generateStep,
      after: ["options"],
    }),

    review: awaitSignal({ name: "review", after: ["generate"] }),

    // shouldRegenerate is a boolean on the review payload (gate when-path).
    regenerateGate: gate({
      when: { from: "steps.review.output.shouldRegenerate" },
      then: "regenerate",
      else: "persist",
      after: ["review"],
    }),

    regenerate: map({
      over: { from: "steps.review.output.regenerateItems" },
      step: regenerateStep,
      after: ["regenerateGate"],
    }),

    "review-final": awaitSignal({
      name: "review-final",
      after: ["regenerate"],
    }),

    // Folded from a `map` of single-piece `deterministicToolStep`s into one
    // native `action`: `multi_source_collateral_persist_pieces` loops over
    // `approvedPieces` in-process (see `persist-tools.ts`). Both `persist`
    // and `persist-after-regen` dispatch the SAME handler — they differ
    // only in which gate's output feeds them. Fatal by design (unchanged):
    // any failed save fails the run. Folding N per-item steps into one
    // action means a crash mid-save now re-runs the WHOLE batch on resume
    // instead of resuming after the already-saved pieces — a real
    // checkpointing change from the old per-item map, acceptable given a
    // review-approved batch is small.
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
