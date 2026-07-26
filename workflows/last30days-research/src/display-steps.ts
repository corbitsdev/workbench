// A stepper entry backed by one or more runtime step ids, in run order.
// Structurally mirrors `@workbench/ui`'s `DisplayStep` (and the server-safe
// `DisplayFlowStep` `@workbench/agents`' catalog classifier reads) without
// depending on either package — this workflow no longer has a custom client
// panel to share the type with (the generic dock renders every step's
// progress from this declaration plus `STEP_UI`), so a local, dependency-free
// type is the whole contract.
export type DisplayStep = {
  key: string;
  label: string;
  stepIds: readonly string[];
  /**
   * Present-progress verb phrase shown on the live status line while this step
   * is in-flight (e.g. "Saving to workbench"). Omit for human gates and intake
   * steps — an unlabeled active step shows no line rather than a stepper noun.
   */
  activityLabel?: string;
};

// The single declaration of this workflow's user-facing step flow (labels,
// grouping, order), consumed by the server catalog classifier that powers the
// animated preview.

// Every runtime step of the multi-source research phase, in run order, terminal
// (`brief`) last — clustered into one display step so the stepper shows a single
// "Research" node and the shared router reads it `completed` only once the brief
// lands.
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

// The live LINE is bespoke (see `currentActivity` in ui.tsx), so these carry no
// `activityLabel`.
export const DISPLAY_STEPS: DisplayStep[] = [
  { key: "intake", label: "Topic", stepIds: ["intake"] },
  { key: "research", label: "Research", stepIds: RESEARCH_STEP_IDS },
  { key: "report", label: "Report", stepIds: ["write"] },
  { key: "done", label: "Done", stepIds: ["persist"] },
];
