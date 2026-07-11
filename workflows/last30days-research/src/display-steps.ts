import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports so the `/ui` browser chunk never pulls
// @intx/agent.

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
