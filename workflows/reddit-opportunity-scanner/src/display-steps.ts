import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports so the `/ui` browser chunk never pulls
// @intx/agent.

// One runtime step per display step, in run order. Machine-work steps carry a
// verb `activityLabel` for the live line; the intake, review, and selection
// gates carry none.
export const STEP_ORDER = [
  "intake",
  "scrape",
  "analyze",
  "review",
  "collect",
  "curate",
  "selection",
  "persist",
] as const;
export type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: "Website",
  scrape: "Crawl",
  analyze: "Strategy",
  review: "Search plan",
  collect: "Collect",
  curate: "Opportunities",
  selection: "Select",
  persist: "Done",
};

const STEP_ACTIVITY: Partial<Record<StepKey, string>> = {
  scrape: "Reading the website",
  analyze: "Building the search plan",
  collect: "Searching Reddit",
  curate: "Curating opportunities",
  persist: "Saving to workbench",
};

export const DISPLAY_STEPS: DisplayStep[] = STEP_ORDER.map((id) => ({
  key: id,
  label: STEP_LABELS[id],
  stepIds: [id],
  ...(STEP_ACTIVITY[id] !== undefined
    ? { activityLabel: STEP_ACTIVITY[id] }
    : {}),
}));
