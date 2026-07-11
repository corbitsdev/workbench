import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports so the `/ui` browser chunk never pulls
// @intx/agent.
//
// Each stepper entry clusters the internal workflow steps it represents, in run
// order. `activityLabel` drives the live line from the in-flight machine work,
// never the stepper noun: while `generate` runs the line reads "Generating
// collateral", not the gate noun "Review". Gate-only groups (Transcript,
// Context, Generate=fmtSelection) carry none.
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "transcript",
    label: "Transcript",
    stepIds: ["intake", "select", "fetch"],
  },
  { key: "context", label: "Context", stepIds: ["context"] },
  {
    key: "painPoints",
    label: "Pain points",
    stepIds: ["analyze", "ppSelection"],
    activityLabel: "Analyzing the call",
  },
  { key: "formats", label: "Generate", stepIds: ["fmtSelection"] },
  {
    key: "review",
    label: "Review",
    stepIds: ["generate", "review"],
    activityLabel: "Generating collateral",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist"],
    activityLabel: "Saving to workbench",
  },
];
