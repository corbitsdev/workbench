import { awaitSignal, defineWorkflow } from "@intx/workflow";
import type { Primitive } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
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

const setupSteps: Record<string, Primitive> = {
  // Root steps receive the run's initial input; the argMap replaces that input
  // with an explicit `{ limit }` (a bare `input` would be passed verbatim and a
  // string run-input fails the step-tool harness). The most recent are
  // preloaded so the intake panel can paginate + search client-side — the DAG
  // is acyclic/fire-once, so there is no "next page" round-trip. Each limit is
  // the tool's own ceiling: artifact_list allows 50, granola_list_notes clamps
  // to 30 (a higher literal would be silently truncated — see the panel's cap
  // note). The panel warns the user when a list is at its ceiling.
  "list-artifacts": deterministicToolStep({
    id: "presentation-list-artifacts",
    title: "List your artifacts",
    tool: "artifact_list",
    argMap: { limit: { literal: 50 } },
  }),
  "list-notes": deterministicToolStep({
    id: "presentation-list-notes",
    title: "List your call notes",
    tool: "granola_list_notes",
    argMap: { limit: { literal: 30 } },
  }),
  intake: awaitSignal({
    name: "intake",
    after: ["list-artifacts", "list-notes"],
  }),
  // `artifactId`/`noteId` are OPTIONAL argMap fields: a text-source intake
  // carries neither, so the harness skips the tool call (no throw, no error
  // log) instead of degrading through the nonFatal isError path.
  "fetch-artifact": deterministicToolStep({
    id: "presentation-fetch-artifact",
    title: "Load the chosen artifact",
    tool: "artifact_read",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { artifactId: { from: "artifactId", optional: true } },
    nonFatal: true,
  }),
  "fetch-note": deterministicToolStep({
    id: "presentation-fetch-note",
    title: "Load the chosen note",
    tool: "granola_get_note",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { noteId: { from: "noteId", optional: true } },
    nonFatal: true,
  }),
  generate: inlineInferenceStep({
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
  render: deterministicToolStep({
    id: "presentation-render",
    title: "Build the deck in Gamma",
    tool: "gamma_create_from_template",
    after: ["generate"],
    input: {
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.generate.output" },
      ],
    },
    argMap: { gammaId: { from: "gammaId" }, prompt: { from: "reply" } },
  }),
  describe: inlineInferenceStep({
    id: "presentation-describe",
    title: "Summarize the deck",
    systemPrompt: PRESENTATION_DESCRIBE_SYSTEM_PROMPT,
    model: LLM_DEFAULT_MODEL,
    after: ["generate"],
    input: { from: "steps.generate.output" },
  }),
  persist: deterministicToolStep({
    id: "presentation-persist",
    title: "Save the deck",
    tool: "artifact_link_gamma_presentation",
    after: ["render", "describe"],
    input: {
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.render.output" },
        { from: "steps.describe.output" },
      ],
    },
    argMap: {
      title: { from: "deckTitle" },
      url: { from: "gammaUrl" },
      description: { from: "reply" },
      gammaId: { from: "gammaId" },
      // render always emits an exportUrl (empty string when Gamma returns no
      // export link) so this mapping never hits the harness's absent-field
      // throw; the persist handler downloads it and stores the PDF durably,
      // treating an empty value as "no PDF".
      pdfUrl: { from: "exportUrl" },
    },
  }),
};

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: setupSteps,
});
