import type { StepUIHints } from "@workbench/blocks";

// The intake gate's `awaitSignal` name (matches the step in index.ts).
export const INTAKE_SIGNAL = "intake";

// Declarative step -> component mapping (CL-3923): which block renders the
// `intake` gate, colocated with the step definition it describes instead of a
// hand-written `blocks.ts` builder. Mirrors INTAKE_FIELDS (the first-intake
// form descriptor for scheduled/pre-filled runs) but in the UIBlock vocabulary
// the live dock renders: topic (required) + focus (optional), emitted
// VERBATIM as `{ topic, focus }` — the pipeline's server-side `normalizeIntake`
// (@workbench/last30days-core) derives `query`/`days` from that payload, so a
// hint-driven run and a panel-driven run hand the pipeline the identical
// shape. Consumed generically by `blocksFromStepUIHints` (@workbench/blocks) —
// no per-workflow builder.
//
// This module must stay free of server-only imports (`@intx/workflow`,
// `@workbench/agents`, and anything that transitively touches `@intx/agent`)
// so the browser can import it directly without pulling in the module that
// constructs the workflow's agent steps at load time. Mirrors the same
// discipline `display-steps.ts` already follows for `DISPLAY_STEPS`.
export const STEP_UI_HINTS: StepUIHints = {
  [INTAKE_SIGNAL]: {
    kind: "form",
    prompt:
      "What should we research? We scan the last 30 days across Hacker News, GitHub, web, Reddit, X, YouTube, and Polymarket, then synthesize a cited brief.",
    submitLabel: "Start research",
    fields: [
      {
        kind: "text",
        name: "topic",
        label: "Topic",
        placeholder: "e.g. AI coding agents for GTM teams",
        required: true,
      },
      {
        kind: "textarea",
        name: "focus",
        label: "Focus (optional)",
        placeholder: "Narrow the query or angle",
      },
    ],
  },
};
