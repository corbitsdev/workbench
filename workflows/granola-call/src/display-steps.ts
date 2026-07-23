import type { DisplayStep } from "@workbench/ui";

/** Catalog / UI display flow for the granola-call workflow. */
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "discover",
    label: "Discover recent calls",
    stepIds: ["discover"],
  },
  {
    key: "digest",
    label: "Write the call digest",
    stepIds: ["digest"],
    activityLabel: "Writing the call digest",
  },
  {
    key: "persist",
    label: "Save the digest",
    stepIds: ["persist"],
  },
];
