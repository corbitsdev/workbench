import type { DisplayStep } from "@workbench/ui";

// Browser-safe display flow shared by the run panel and catalog preview.
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "sources",
    label: "Sources",
    stepIds: ["list-artifacts", "list-notes", "list-issues", "sources"],
  },
  {
    key: "options",
    label: "Content",
    stepIds: ["fetch-artifacts", "fetch-notes", "fetch-issues", "options"],
    activityLabel: "Loading sources",
  },
  {
    key: "review",
    label: "Review",
    stepIds: ["generate", "review", "regenerateGate", "regenerate", "review-final"],
    activityLabel: "Generating collateral",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist", "persist-after-regen"],
    activityLabel: "Saving to workbench",
  },
];
