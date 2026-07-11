import { awaitSignal, defineWorkflow, gate } from "@intx/workflow";
import type { Primitive, Selector } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
  LLM_DEFAULT_MODEL,
} from "@workbench/agents";
import {
  PRESENTATION_DESCRIBE_SYSTEM_PROMPT,
  PRESENTATION_GENERATE_SYSTEM_PROMPT,
} from "./prompts";
import { MAX_ROUNDS } from "./constants";

export const label = "Gamma Presentation Creator";
export const description =
  "Turn any artifact, call, or pasted text into a Gamma deck, refining it round by round until you approve it.";
export const kind = "gamma-presentation-creator";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// Number of generate → render → preview rounds (defined in ./constants so the
// browser panel can share it without importing this server-only module). Each
// round re-renders a fresh Gamma deck from the user's feedback (Gamma cannot
// edit a deck in place), and the preview gate lets the user approve — which
// skips the remaining rounds via `gate()` — or refine with notes. The last
// round has no gate: its preview leads straight to persistence.
export { MAX_ROUNDS };

// The source feeding every round: the intake brief plus both readers. The
// generate prompt uses whichever source resolved (or the pasted text).
// Branching the readers with gates was tried and rejected: nested gates
// converging on `generate` raced and corrupted the diamond.
const SOURCE_MERGE: Selector[] = [
  { from: "steps.intake.output" },
  { from: "steps.fetch-artifact.output" },
  { from: "steps.fetch-note.output" },
];

function roundSteps(round: number): Record<string, Primitive> {
  const gen = `generate-${round}`;
  const rnd = `render-${round}`;
  const dsc = `describe-${round}`;
  const prev = `preview-${round}`;
  const chk = `check-${round}`;
  const per = `persist-${round}`;
  const isLast = round === MAX_ROUNDS;

  const genInput: Selector =
    round === 1
      ? { merge: SOURCE_MERGE }
      : {
          merge: [
            ...SOURCE_MERGE,
            { from: `steps.generate-${round - 1}.output` },
            { from: `steps.preview-${round - 1}.output` },
          ],
        };

  const steps: Record<string, Primitive> = {
    [gen]: inlineInferenceStep({
      id: `presentation-${gen}`,
      title: round === 1 ? "Draft the deck" : "Revise the deck",
      systemPrompt: PRESENTATION_GENERATE_SYSTEM_PROMPT,
      after:
        round === 1 ? ["fetch-artifact", "fetch-note"] : [`check-${round - 1}`],
      input: genInput,
    }),
    [rnd]: deterministicToolStep({
      id: `presentation-${rnd}`,
      title:
        round === 1 ? "Build the deck in Gamma" : "Rebuild the deck in Gamma",
      tool: "gamma_create_from_template",
      after: [gen],
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: `steps.${gen}.output` },
        ],
      },
      argMap: { gammaId: { from: "gammaId" }, prompt: { from: "reply" } },
    }),
    [dsc]: inlineInferenceStep({
      id: `presentation-${dsc}`,
      title: "Summarize the deck",
      systemPrompt: PRESENTATION_DESCRIBE_SYSTEM_PROMPT,
      model: LLM_DEFAULT_MODEL,
      after: [gen],
      input: { from: `steps.${gen}.output` },
    }),
    [prev]: awaitSignal({ name: prev, after: [rnd] }),
    [per]: deterministicToolStep({
      id: `presentation-${per}`,
      title: "Save the deck",
      tool: "artifact_link_gamma_presentation",
      after: isLast ? [prev, dsc] : [chk, dsc],
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: `steps.${rnd}.output` },
          { from: `steps.${dsc}.output` },
        ],
      },
      argMap: {
        title: { from: "deckTitle" },
        url: { from: "gammaUrl" },
        description: { from: "reply" },
        gammaId: { from: "gammaId" },
        // render-N always emits an exportUrl (empty string when Gamma returns
        // no export link) so this mapping never hits the harness's absent-field
        // throw; the persist handler downloads it and stores the PDF durably,
        // treating an empty value as "no PDF".
        pdfUrl: { from: "exportUrl" },
      },
    }),
  };

  if (!isLast) {
    steps[chk] = gate({
      when: { from: `steps.${prev}.output.approved` },
      then: per,
      else: `generate-${round + 1}`,
      after: [prev],
    });
  }

  return steps;
}

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
  "fetch-artifact": deterministicToolStep({
    id: "presentation-fetch-artifact",
    title: "Load the chosen artifact",
    tool: "artifact_read",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { artifactId: { from: "artifactId" } },
    nonFatal: true,
  }),
  "fetch-note": deterministicToolStep({
    id: "presentation-fetch-note",
    title: "Load the chosen note",
    tool: "granola_get_note",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { noteId: { from: "noteId" } },
    nonFatal: true,
  }),
};

const steps: Record<string, Primitive> = {
  ...setupSteps,
  ...roundSteps(1),
  ...roundSteps(2),
  ...roundSteps(3),
};

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps,
});
