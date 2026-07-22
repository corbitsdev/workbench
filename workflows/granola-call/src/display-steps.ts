import type { DisplayStep } from "@workbench/ui";

/** Catalog / UI display flow for the granola-call workflow. */
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "fetch",
    label: "Fetch note",
    stepIds: ["fetch"],
  },
  {
    key: "normalize",
    label: "Normalize",
    stepIds: ["normalize"],
  },
  {
    key: "classify",
    label: "Classify",
    stepIds: ["classify"],
  },
  {
    key: "build-prompt",
    label: "Build analysis prompt",
    stepIds: ["build-prompt"],
  },
  {
    key: "analyze",
    label: "Analyze",
    stepIds: ["analyze"],
    activityLabel: "Analyzing the call",
  },
  {
    key: "parse",
    label: "Parse analysis",
    stepIds: ["parse"],
  },
  {
    key: "prepare",
    label: "Prepare artifacts",
    stepIds: ["prepare"],
  },
  {
    key: "persist",
    label: "Persist artifacts",
    stepIds: ["persist-pain", "persist-summary", "persist-brief"],
    activityLabel: "Saving call artifacts",
  },
  {
    key: "create-tasks",
    label: "Create tasks",
    stepIds: ["create-tasks"],
  },
  {
    key: "fanout",
    label: "Fan out",
    stepIds: ["fanout"],
  },
  {
    key: "emit",
    label: "Emit outputs",
    stepIds: ["emit"],
  },
];
