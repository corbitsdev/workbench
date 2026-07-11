import type { DisplayStep } from "@workbench/ui";
import { MAX_ROUNDS } from "./constants";

// The single, browser-safe declaration of this workflow's user-facing step flow
// (labels, grouping, order). Consumed by the client panel (ui.tsx) for the live
// run stepper AND, via the index re-export, by the server catalog classifier
// that powers the animated preview — so both surfaces stay in sync. This module
// must stay free of server-only imports (no ./index, no @workbench/agents) so
// the `/ui` browser chunk never pulls @intx/agent.

const ROUNDS = Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1);

// Four display steps cluster the repeating per-round runtime steps. The
// machine-work groups carry a verb `activityLabel` for the live status line;
// the source and review groups carry none (they wait on the user).
export const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "source",
    label: "Source",
    stepIds: [
      "list-artifacts",
      "list-notes",
      "intake",
      "fetch-artifact",
      "fetch-note",
    ],
  },
  {
    key: "draft",
    label: "Draft",
    stepIds: ROUNDS.flatMap((r) => [`generate-${r}`, `render-${r}`]),
    activityLabel: "Building the deck",
  },
  {
    key: "review",
    label: "Review",
    stepIds: ROUNDS.map((r) => `preview-${r}`),
  },
  {
    key: "done",
    label: "Done",
    stepIds: ROUNDS.map((r) => `persist-${r}`),
    activityLabel: "Saving to workbench",
  },
];
