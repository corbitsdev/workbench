// Structurally identical to `DisplayStep` from `@workbench/ui` (key/label/
// stepIds/activityLabel?) — declared locally so this module carries no
// `@workbench/ui` dependency; every consumer (the client stepper, the hub's
// catalog classifier) reads this shape structurally, not by nominal type.
export interface DisplayStep {
  key: string;
  label: string;
  stepIds: readonly string[];
  activityLabel?: string;
}

// The single, browser-safe declaration of this workflow's user-facing step
// flow (labels, grouping, order).
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "sources",
    label: "Sources",
    stepIds: [
      "list-artifacts",
      "list-notes",
      "list-issues",
      "prepareSourcesGate",
      "sources",
    ],
    activityLabel: "Loading sources",
  },
  {
    key: "options",
    label: "Content",
    stepIds: ["fetchSources", "prepareOptionsGate", "options"],
    activityLabel: "Loading source content",
  },
  {
    key: "review",
    label: "Review",
    stepIds: [
      "buildGenerateItems",
      "generate",
      "prepareReviewGate",
      "review",
      "prepareRegenerateItems",
      "regenerateGate",
      "regenerate",
      "prepareReviewFinalGate",
      "review-final",
    ],
    activityLabel: "Generating collateral",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist", "persist-after-regen"],
    activityLabel: "Saving to workbench",
  },
];
