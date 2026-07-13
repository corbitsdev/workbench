import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier that
// powers the animated preview — so both surfaces stay in sync. This module must
// stay free of server-only imports so the `/ui` browser chunk never pulls
// @intx/agent.
//
// The whole Sumble + X enrichment fan-out is clustered into one "Research" node
// so the stepper shows a single research step; the intake and review gates carry
// no `activityLabel` (they are human pauses, not machine work).
export const RESEARCH_STEP_IDS = [
  "resolve",
  "teams",
  "jobs",
  "techStack",
  "contacts",
  "signals",
  "enrichSocial",
] as const;

export const DISPLAY_STEPS: DisplayStep[] = [
  { key: "account", label: "Account", stepIds: ["intake"] },
  {
    key: "research",
    label: "Research",
    stepIds: [...RESEARCH_STEP_IDS],
    activityLabel: "Researching the account",
  },
  {
    key: "brief",
    label: "Brief",
    stepIds: ["synthesize", "review"],
    activityLabel: "Writing the account brief",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["packageArtifact"],
    activityLabel: "Saving to workbench",
  },
];
