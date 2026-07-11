import type { DisplayStep } from "@workbench/ui";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports so the `/ui` browser chunk never pulls
// @intx/agent.
//
// Each stepper entry clusters the internal workflow steps it represents, in run
// order. `activityLabel` drives the live line from in-flight machine work;
// gate-only groups carry none.
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "setup",
    label: "Task setup",
    stepIds: [
      "listMembers",
      "selectMember",
      "listTasks",
      "selectTask",
      "fetchTask",
    ],
  },
  {
    key: "analyze",
    label: "Analyze",
    stepIds: ["analyze", "clarify"],
    activityLabel: "Analyzing the task",
  },
  {
    key: "generate",
    label: "Act",
    stepIds: ["execute", "reviewArtifacts"],
    activityLabel: "Carrying out the plan",
  },
  {
    key: "review",
    label: "Review",
    stepIds: ["review", "persist"],
    activityLabel: "Saving to workbench",
  },
  {
    key: "sync",
    label: "Write back",
    stepIds: ["suggest", "approveSync", "writeNote", "writeComplete"],
    activityLabel: "Writing back to Attio",
  },
];
