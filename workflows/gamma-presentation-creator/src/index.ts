import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import type { Primitive } from "@intx/workflow";
import {
  canonicalizeStepToolName,
  deterministicToolStep,
  agentStep,
  LLM_DEFAULT_MODEL,
} from "@workbench/agents";
import {
  PRESENTATION_DESCRIBE_SYSTEM_PROMPT,
  PRESENTATION_GENERATE_SYSTEM_PROMPT,
} from "./prompts";

export const label = "Gamma Presentation Creator";
export const description =
  "Turn any artifact, call, or pasted text into a Gamma deck.";
export const kind = "gamma-presentation-creator";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch (CL-4454).
export const ARTIFACT_LIST_HANDLER = canonicalizeStepToolName(
  "presentation-list-artifacts",
  "artifact_list",
);
export const GRANOLA_LIST_NOTES_HANDLER = canonicalizeStepToolName(
  "presentation-list-notes",
  "granola_list_notes",
);
export const PREPARE_RENDER_HANDLER = canonicalizeStepToolName(
  "presentation-prepare-render",
  "gamma_presentation_creator_prepare_render",
);
export const GAMMA_CREATE_FROM_TEMPLATE_HANDLER = canonicalizeStepToolName(
  "presentation-render",
  "gamma_create_from_template",
);
export const PREPARE_PERSIST_HANDLER = canonicalizeStepToolName(
  "presentation-prepare-persist",
  "gamma_presentation_creator_prepare_persist",
);
export const ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER =
  canonicalizeStepToolName(
    "presentation-persist",
    "artifact_link_gamma_presentation",
  );

const setupSteps: Record<string, Primitive> = {
  // Root steps receive the run's initial input, which native `action` ignores
  // in favor of a `literal` selector (a bare `from` would pass the run input
  // verbatim and a string run-input fails the step-tool harness). The most
  // recent are preloaded so the intake panel can paginate + search
  // client-side — the DAG is acyclic/fire-once, so there is no "next page"
  // round-trip. Each limit is the tool's own ceiling: artifact_list allows 50,
  // granola_list_notes clamps to 30 (a higher literal would be silently
  // truncated — see the panel's cap note). The panel warns the user when a
  // list is at its ceiling.
  "list-artifacts": action({
    handler: ARTIFACT_LIST_HANDLER,
    input: { literal: { limit: 50 } },
    effect: { requires: [ARTIFACT_LIST_HANDLER] },
  }),
  "list-notes": action({
    handler: GRANOLA_LIST_NOTES_HANDLER,
    input: { literal: { limit: 30 } },
    effect: { requires: [GRANOLA_LIST_NOTES_HANDLER] },
  }),
  intake: awaitSignal({
    name: "intake",
    after: ["list-artifacts", "list-notes"],
  }),
  // `artifactId`/`noteId` are the SOLE argMap field of these steps and each
  // is also the underlying tool's only required argument (artifact_read /
  // granola_get_note both require it) — there is no sensible "call the tool
  // without it", so these use `skipStepIfAbsent` rather than `optional`: a
  // text-source intake carries neither, so the harness skips the tool call
  // entirely (no throw, no error log) instead of degrading through the
  // nonFatal isError path.
  "fetch-artifact": deterministicToolStep({
    id: "presentation-fetch-artifact",
    title: "Load the chosen artifact",
    tool: "artifact_read",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { artifactId: { from: "artifactId", skipStepIfAbsent: true } },
    nonFatal: true,
  }),
  "fetch-note": deterministicToolStep({
    id: "presentation-fetch-note",
    title: "Load the chosen note",
    tool: "granola_get_note",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { noteId: { from: "noteId", skipStepIfAbsent: true } },
    nonFatal: true,
  }),
  generate: agentStep({
    id: "presentation-generate",
    title: "Draft the deck",
    systemPrompt: PRESENTATION_GENERATE_SYSTEM_PROMPT,
    after: ["fetch-artifact", "fetch-note"],
    input: {
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.fetch-artifact.output" },
        { from: "steps.fetch-note.output" },
      ],
    },
  }),
  // `generate`'s draft rides on the agent-step convention `reply` field;
  // `gamma_create_from_template`'s argument is `prompt` — a rename no native
  // selector can express (and the tool's own arg name is left alone: it
  // documents the Gamma domain concept, not this workflow's plumbing). The
  // private `prepare-render` shaping tool (`./tools.ts`) does the rename.
  "prepare-render": action({
    handler: PREPARE_RENDER_HANDLER,
    input: {
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.generate.output" },
      ],
    },
    effect: { requires: [PREPARE_RENDER_HANDLER] },
    after: ["generate"],
  }),
  // Native `action`: `prepare-render`'s output already carries
  // gamma_create_from_template's own argument names, so this step is a pure
  // passthrough.
  render: action({
    handler: GAMMA_CREATE_FROM_TEMPLATE_HANDLER,
    input: { from: "steps.prepare-render.output.content" },
    effect: { requires: [GAMMA_CREATE_FROM_TEMPLATE_HANDLER] },
    after: ["prepare-render"],
  }),
  describe: agentStep({
    id: "presentation-describe",
    title: "Summarize the deck",
    systemPrompt: PRESENTATION_DESCRIBE_SYSTEM_PROMPT,
    model: LLM_DEFAULT_MODEL,
    after: ["generate"],
    input: { from: "steps.generate.output" },
  }),
  // gamma_create_from_template is a "full" tool: its deck result lands at
  // `render.output.content` as an object (never a stringified envelope), and
  // `url`/`gammaId` on it already match `artifact_link_gamma_presentation`'s
  // own argument names verbatim — merging render's content AFTER intake's
  // output lets the NEW deck's gammaId win over the template id that also
  // rides on the intake payload, the same override order the old argMap
  // relied on. Only `deckTitle` → `title`, the describe agent's `reply` →
  // `description`, and `exportUrl` → `pdfUrl` are renames, done by the
  // private `prepare-persist` shaping tool.
  "prepare-persist": action({
    handler: PREPARE_PERSIST_HANDLER,
    input: {
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.render.output.content" },
        { from: "steps.describe.output" },
      ],
    },
    effect: { requires: [PREPARE_PERSIST_HANDLER] },
    after: ["render", "describe"],
  }),
  persist: action({
    handler: ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER,
    input: { from: "steps.prepare-persist.output.content" },
    effect: { requires: [ARTIFACT_LINK_GAMMA_PRESENTATION_HANDLER] },
    after: ["prepare-persist"],
  }),
};

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: setupSteps,
});
