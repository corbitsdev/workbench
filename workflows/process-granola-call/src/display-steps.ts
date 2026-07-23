import type { DisplayStep } from "@workbench/ui";

/** Catalog / UI display flow for the process-granola-call child workflow. */
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "fetch",
    label: "Fetch the transcript",
    stepIds: ["fetch"],
  },
  {
    key: "transcript",
    label: "Save the raw transcript",
    stepIds: ["transcript"],
  },
  {
    key: "extract",
    label: "Extract working notes",
    stepIds: ["extract", "processed"],
    activityLabel: "Extracting working notes",
  },
  {
    key: "finalize",
    label: "Verify and write call notes",
    stepIds: ["finalize", "persist"],
    activityLabel: "Writing the call notes",
  },
];
