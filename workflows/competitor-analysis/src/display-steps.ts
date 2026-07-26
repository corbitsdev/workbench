// Browser-safe user-facing step flow, consumed via the index re-export by the
// server catalog classifier. Must stay free of server-only imports so the
// hub's catalog build never pulls in @intx/agent.
//
// `DisplayStep`'s shape is duplicated locally (rather than imported from
// `@workbench/ui`) so this package carries no `@workbench/ui` dependency — it
// is structurally identical to `@workbench/ui`'s `DisplayStep`, which is all
// the hub's catalog classifier needs.
type DisplayStep = {
  key: string;
  label: string;
  stepIds: readonly string[];
  activityLabel?: string;
};

export const DISPLAY_STEPS: DisplayStep[] = [
  { key: "company", label: "Company", stepIds: ["intake"] },
  {
    key: "research",
    label: "Research",
    stepIds: ["scrape", "profile", "discover"],
    activityLabel: "Researching the company and competitors",
  },
  {
    key: "report",
    label: "Report",
    stepIds: ["synthesize", "reviewGate", "review"],
    activityLabel: "Writing the competitor report",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["document", "packageArtifact"],
    activityLabel: "Saving to workbench",
  },
];
