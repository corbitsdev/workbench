import { awaitSignal, defineWorkflow, gate } from "@intx/workflow";
import type { Primitive, Selector } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { PRESENTATION_GENERATE_SYSTEM_PROMPT } from "./prompts";

export const label = "Gamma Presentation Creator";
export const description =
  "Turn any artifact, call, or pasted text into a Gamma deck, refining it round by round until you approve it.";
export const kind = "gamma-presentation-creator";

// Number of generate → render → preview rounds. Each round re-renders a fresh
// Gamma deck from the user's feedback (Gamma cannot edit a deck in place), and
// the preview gate lets the user approve — which skips the remaining rounds via
// `gate()` — or refine with notes. The last round has no gate: its preview
// leads straight to persistence.
export const MAX_ROUNDS = 3;

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
      systemPrompt: PRESENTATION_GENERATE_SYSTEM_PROMPT,
      after:
        round === 1 ? ["fetch-artifact", "fetch-note"] : [`check-${round - 1}`],
      input: genInput,
    }),
    [rnd]: deterministicToolStep({
      id: `presentation-${rnd}`,
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
    [prev]: awaitSignal({ name: prev, after: [rnd] }),
    [per]: deterministicToolStep({
      id: `presentation-${per}`,
      tool: "artifact_create",
      after: isLast ? [prev] : [chk],
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: `steps.${gen}.output` },
        ],
      },
      argMap: {
        title: { from: "deckTitle" },
        kind: { literal: "presentation" },
        content: { from: "reply" },
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
  "list-templates": deterministicToolStep({
    id: "presentation-list-templates",
    tool: "gamma_list_templates",
  }),
  "list-artifacts": deterministicToolStep({
    id: "presentation-list-artifacts",
    tool: "artifact_list",
  }),
  "list-notes": deterministicToolStep({
    id: "presentation-list-notes",
    tool: "granola_list_notes",
  }),
  intake: awaitSignal({
    name: "intake",
    after: ["list-templates", "list-artifacts", "list-notes"],
  }),
  "fetch-artifact": deterministicToolStep({
    id: "presentation-fetch-artifact",
    tool: "artifact_read",
    after: ["intake"],
    input: { from: "steps.intake.output" },
    argMap: { artifactId: { from: "artifactId" } },
    nonFatal: true,
  }),
  "fetch-note": deterministicToolStep({
    id: "presentation-fetch-note",
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
