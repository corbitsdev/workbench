// Structurally identical to `DisplayFlowStep` from `@workbench/agents`
// (key/label/stepIds) — declared locally so this module carries no
// `@workbench/agents` dependency; every consumer (the client stepper, the
// hub's catalog classifier) reads this shape structurally, not by nominal
// type.
export interface DisplayFlowStep {
  key: string;
  label: string;
  stepIds: readonly string[];
}

// Mirrors last30days-research's RESEARCH_STEP_IDS (this workflow reuses
// buildResearchSteps() verbatim) clustered into one "Research" node, plus the
// scripts-briefs-specific write/persist tail.
export const RESEARCH_STEP_IDS = [
  "ground",
  "groundQueries",
  "web",
  "webB",
  "webC",
  "hackernews",
  "github",
  "reddit",
  "x",
  "youtube",
  "polymarket",
  "entities",
  "entityQueries",
  "web2",
  "reddit2",
  "x2",
  "youtube2",
  "collect",
  "curate",
  "brief",
] as const;

/** User-facing flow for the catalog / run UI (key + stepIds for the stepper). */
export const DISPLAY_STEPS: DisplayFlowStep[] = [
  { key: "intake", label: "Topic", stepIds: ["intake"] },
  { key: "research", label: "Research", stepIds: [...RESEARCH_STEP_IDS] },
  { key: "write", label: "Script & Brief", stepIds: ["write"] },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist-prepare", "persist"],
  },
];
