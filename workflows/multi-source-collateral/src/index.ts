import { action, awaitSignal, defineWorkflow, gate, map } from "@intx/workflow";
import {
  canonicalizeStepToolName,
  deterministicToolStep,
  agentStep,
} from "@workbench/agents";
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
// map's inner step (CL-4454) — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const ARTIFACT_LIST_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-list-artifacts",
  "artifact_list",
);
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "multi-source-collateral-list-notes",
  "granola_list_notes",
);

// ---------------------------------------------------------------------------
// Step graph
//
// list-artifacts | list-notes | list-issues  (parallel roots)
//   → sources awaitSignal
// fetch-artifacts | fetch-notes | fetch-issues  (maps; empty arrays are no-ops)
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

// NOT migrated to native `action` — all five steps below (persist,
// persist-after-regen, fetch-artifact, fetch-note, fetch-issue) are each used
// as a `map`'s inner `step`. `MapPrimitive.step` is typed `StepPrimitive` (see
// `interchange/packages/workflow/src/definition/primitives.ts`), not
// `Primitive` — an `action` cannot be a map's inner step at all; independently
// the deploy-time capability walk's `extractAgent` (`interchange/packages/
// workflow-deploy/src/capability-walk.ts`) only reads `primitive.step.agent`
// for a `map` node, never an inner step's `effect`, so even a same-shape
// action inside a map would pin no tool package. This is the same structural
// blocker `pain-point-collateral`'s `persist` step documents (CL-4454).
const persistStep = deterministicToolStep({
  id: "multi-source-collateral-persist",
  title: "Save the collateral",
  tool: "artifact_create",
  input: { from: "trigger.payload" },
  argMap: {
    title: { from: "title" },
    kind: { from: "format" },
    content: { from: "content" },
  },
});

const persistAfterRegenStep = deterministicToolStep({
  id: "multi-source-collateral-persist-after-regen",
  title: "Save the collateral",
  tool: "artifact_create",
  input: { from: "trigger.payload" },
  argMap: {
    title: { from: "title" },
    kind: { from: "format" },
    content: { from: "content" },
  },
});

const fetchArtifactStep = deterministicToolStep({
  id: "multi-source-collateral-fetch-artifact",
  title: "Load artifact",
  tool: "artifact_read",
  input: { from: "trigger.payload" },
  argMap: {
    artifactId: { from: "artifactId" },
  },
});

const fetchNoteStep = deterministicToolStep({
  id: "multi-source-collateral-fetch-note",
  title: "Load call note",
  tool: "granola_get_note",
  input: { from: "trigger.payload" },
  argMap: {
    noteId: { from: "noteId" },
  },
});

const fetchIssueStep = deterministicToolStep({
  id: "multi-source-collateral-fetch-issue",
  title: "Load Linear issue",
  tool: "linear_get_issue",
  input: { from: "trigger.payload" },
  argMap: {
    id: { from: "id" },
  },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Native `action`: artifact_list's arktype schema is { kind?, limit? },
    // so a literal { limit: 50 } is the exact argument object verbatim — no
    // reshape needed (CL-4454).
    "list-artifacts": action({
      handler: ARTIFACT_LIST_HANDLER,
      input: { literal: { limit: 50 } },
      effect: { requires: [ARTIFACT_LIST_HANDLER] },
    }),

    // Native `action`: granola_list_notes takes limit/cursor/date filters, all
    // optional, so a literal { limit: 30 } is the exact argument object
    // verbatim — no reshape needed (CL-4454).
    "list-notes": action({
      handler: GRANOLA_LIST_NOTES_HANDLER,
      input: { literal: { limit: 30 } },
      effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
    }),

    // Linear may be unconfigured; nonFatal keeps the multi-source chooser
    // usable. NOT migrated to native `action` — native has no error-swallow
    // equivalent to `nonFatal` (the runtime propagates any thrown action
    // error straight to `RunFailed`), and Linear being unconfigured is an
    // expected, not exceptional, case here. Tracked as a separate ticket
    // (CL-4454 follow-up) once/if the runtime grows a per-action
    // catch-and-continue.
    "list-issues": deterministicToolStep({
      id: "multi-source-collateral-list-issues",
      title: "List Linear issues",
      tool: "linear_list_issues",
      input: { literal: { first: 50 } },
      nonFatal: true,
    }),

    sources: awaitSignal({
      name: "sources",
      after: ["list-artifacts", "list-notes", "list-issues"],
    }),

    "fetch-artifacts": map({
      over: { from: "steps.sources.output.artifactItems" },
      step: fetchArtifactStep,
      after: ["sources"],
    }),

    "fetch-notes": map({
      over: { from: "steps.sources.output.noteItems" },
      step: fetchNoteStep,
      after: ["sources"],
    }),

    "fetch-issues": map({
      over: { from: "steps.sources.output.issueItems" },
      step: fetchIssueStep,
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

    "persist-after-regen": map({
      over: { from: "steps.review-final.output.approvedPieces" },
      step: persistAfterRegenStep,
      after: ["review-final"],
    }),

    persist: map({
      over: { from: "steps.review.output.approvedPieces" },
      step: persistStep,
      after: ["regenerateGate"],
    }),
  },
});
