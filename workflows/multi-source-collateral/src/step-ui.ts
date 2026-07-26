// Declarative step -> UI map (see `packages/workbench-shared/src/step-ui.ts`
// for the full contract this shape mirrors) — colocated with the workflow's
// step definitions instead of a hand-written `blocks.ts`/`ui.tsx`. `StepUIMap`
// below is a local, structural mirror of that package's `StepUI`/`StepUIEntry`
// types (types only — no runtime import), so this workflow package carries no
// dependency on `@workbench/shared` at all; the host-side derivation
// (`blocksFromStepUI` in `@workbench/blocks`) validates the map structurally
// when it consumes it.
//
// Every gate here is data-driven (`gateFromOutput`): the complex, per-run UI
// this workflow used to render with a bespoke `ui.tsx` panel (multi-select
// sources across three kinds, content-type + prompt-override options, swipe
// review with regenerate) is now expressed as `form`/`reviewList` UIBlocks
// built by this workflow's own tools (see tools.ts) — no per-workflow React
// component, no hand-written `blocks.ts` dock builder.
export const SOURCES_SIGNAL = "sources";
export const OPTIONS_SIGNAL = "options";
export const REVIEW_SIGNAL = "review";
export const REVIEW_FINAL_SIGNAL = "review-final";

interface StepUIInputField {
  kind: "text" | "textarea" | "number" | "select" | "multiSelect";
  name: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
}

interface StepUIEntry {
  role?: "intake" | "review" | "persist" | "display";
  title?: string;
  prompt?: string;
  submitLabel?: string;
  input?: StepUIInputField[];
  gateFromOutput?: boolean;
  gateSourceStep?: string;
}

export type StepUIMap = Record<string, StepUIEntry>;

export const STEP_UI: StepUIMap = {
  [SOURCES_SIGNAL]: {
    role: "intake",
    gateFromOutput: true,
    gateSourceStep: "prepareSourcesGate",
  },
  [OPTIONS_SIGNAL]: {
    role: "intake",
    gateFromOutput: true,
    gateSourceStep: "prepareOptionsGate",
  },
  [REVIEW_SIGNAL]: {
    role: "review",
    gateFromOutput: true,
    gateSourceStep: "prepareReviewGate",
  },
  [REVIEW_FINAL_SIGNAL]: {
    role: "review",
    gateFromOutput: true,
    gateSourceStep: "prepareReviewFinalGate",
  },
};
