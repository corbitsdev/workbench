import type { DisplayStep } from "@workbench/ui";

/** Catalog / UI display flow for the granola-call fan-out parent. */
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "discover",
    label: "Discover recent calls",
    stepIds: ["discover"],
  },
  {
    key: "spawn",
    label: "Start per-call processing",
    stepIds: ["spawn"],
    activityLabel: "Starting per-call processing",
  },
];
