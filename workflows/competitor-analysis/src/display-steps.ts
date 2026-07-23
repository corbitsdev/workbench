import type { DisplayStep } from "@workbench/ui";

// Browser-safe user-facing step flow. Consumed by the client panel and, via the
// index re-export, by the server catalog classifier. Must stay free of
// server-only imports so the `/ui` browser chunk never pulls @intx/agent.
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
    stepIds: ["synthesize", "review"],
    activityLabel: "Writing the competitor report",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["document", "packageArtifact"],
    activityLabel: "Saving to workbench",
  },
];
