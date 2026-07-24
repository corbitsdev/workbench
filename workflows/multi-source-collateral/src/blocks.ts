/**
 * Dock blocks for multi-source-collateral (CL-4034).
 *
 * Complex multi-select sources, content-type options with prompt overrides, and
 * Good/Bad/Regenerate review stay on the run-page panel. The dock shows progress
 * plus a run-page link at each pending gate.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";

export const SOURCES_SIGNAL = "sources";
export const OPTIONS_SIGNAL = "options";
export const REVIEW_SIGNAL = "review";
export const REVIEW_FINAL_SIGNAL = "review-final";

const PROGRESS_STEP_IDS = [
  "list-artifacts",
  "list-notes",
  "list-issues",
  "sources",
  "fetch-artifacts",
  "fetch-notes",
  "fetch-issues",
  "options",
  "generate",
  "review",
  "regenerateGate",
  "regenerate",
  "review-final",
  "persist",
  "persist-after-regen",
] as const;

export interface MultiSourceCollateralBlockInput extends DockRunInput {
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

function gateLink(runId: string, signalName: string): UIBlock {
  switch (signalName) {
    case SOURCES_SIGNAL:
      return runPageLink(
        runId,
        "Choose sources",
        "Pick artifacts, Granola notes, Linear issues, and/or free text on the run page.",
      );
    case OPTIONS_SIGNAL:
      return runPageLink(
        runId,
        "Pick content types",
        "Select content types, options, and optional prompt overrides on the run page.",
      );
    case REVIEW_SIGNAL:
      return runPageLink(
        runId,
        "Review drafts",
        "Swipe Good / Bad / Regenerate with feedback on the run page.",
      );
    case REVIEW_FINAL_SIGNAL:
      return runPageLink(
        runId,
        "Review regenerated drafts",
        "Approve or discard regenerated pieces on the run page.",
      );
    default:
      return runPageLink(
        runId,
        "Continue on run page",
        `Complete the ${humanizeStepId(signalName)} step on the run page.`,
      );
  }
}

export function buildMultiSourceCollateralBlocks(
  input: MultiSourceCollateralBlockInput,
): UIBlock[] {
  const progressSteps: ProgressStep[] = PROGRESS_STEP_IDS.map((stepId) => {
    const phase = input.state.steps.get(stepId)?.phase;
    return {
      id: stepId,
      label: humanizeStepId(stepId),
      state: progressStateForStepPhase(phase),
    };
  });

  const blocks: UIBlock[] = [
    {
      kind: "progress",
      title: "Multi-source collateral",
      steps: progressSteps,
    },
  ];

  const pending = pendingGateForRun(input.state, input.pendingGate);
  if (pending) {
    blocks.push(gateLink(input.runId, pending.signalName));
  }

  return blocks;
}
