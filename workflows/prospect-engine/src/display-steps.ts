import type { DisplayFlowStep } from "@workbench/agents";

/** Runtime steps the run panel watches for failure (includes non-stepper plumbing). */
export const PROSPECT_ENGINE_FAILURE_WATCH_STEP_IDS = [
  "initBudget",
  "findLedger",
  "readLedger",
  "parseLedger",
  "pipeline",
  "growthList",
  "enterpriseList",
  "extractListOrgs",
  "discover",
  "dedupe",
  "score",
  "qualify",
  "mapReveal",
  "formatReport",
  "persist",
  "formatDigest",
  "mergeLedger",
  "saveLedger",
  "addGrowth",
  "addEnterprise",
  "mailRefs",
  "mail",
  "notify",
] as const;

/** User-facing flow for the catalog / run UI (key + stepIds for the stepper). */
export const DISPLAY_STEPS: DisplayFlowStep[] = [
  {
    key: "prelude",
    label: "Load budget and exclusion lists",
    stepIds: [
      "initBudget",
      "findLedger",
      "readLedger",
      "parseLedger",
      "pipeline",
      "growthList",
      "enterpriseList",
      "extractListOrgs",
    ],
  },
  {
    key: "discover",
    label: "Discover candidates",
    stepIds: ["discover"],
  },
  {
    key: "filter",
    label: "Dedupe and score",
    stepIds: ["dedupe", "score", "qualify"],
  },
  {
    key: "map",
    label: "Map contacts",
    stepIds: ["mapReveal"],
  },
  {
    key: "package",
    label: "Package report",
    stepIds: ["formatReport", "persist", "formatDigest"],
  },
  {
    key: "deliver",
    label: "Deliver",
    stepIds: [
      "mergeLedger",
      "saveLedger",
      "addGrowth",
      "addEnterprise",
      "mailRefs",
      "mail",
      "notify",
    ],
  },
];
