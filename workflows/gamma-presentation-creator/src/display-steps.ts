import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports (no ./index, no @workbench/agents) so
// the `/ui` browser chunk never pulls @intx/agent.
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "source",
    label: "Source",
    stepIds: [
      "list-artifacts",
      "list-notes",
      "intake",
      "fetch-artifact",
      "fetch-note",
    ],
  },
  {
    key: "draft",
    label: "Draft",
    stepIds: ["generate", "render"],
    activityLabel: "Building the deck",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist"],
    activityLabel: "Saving to workbench",
  },
];
