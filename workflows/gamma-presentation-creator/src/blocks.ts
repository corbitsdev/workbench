/**
 * The gamma-presentation-creator workflow's own dock blocks.
 *
 * The workflow is single-shot: a text/artifact/note-driven `intake`
 * gate collects the deck brief, then the run generates, renders, describes,
 * and persists the deck with no further human decision — the per-round
 * preview/refine gate this file previously rendered (CL-2730) no longer
 * exists. The dock shows progress plus a run-page link for the one gate that
 * needs input the dock can't collect (the multi-field intake form), and the
 * completed-run link once the deck is saved.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";

/** The intake gate's `awaitSignal` name (matches index.ts). */
export const INTAKE_SIGNAL = "intake";

export interface GammaBlockInput extends DockRunInput {
  /**
   * Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces
   * (the value is the step's output, NOT wrapped in `{ output }`).
   */
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

export function buildGammaBlocks(input: GammaBlockInput): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === INTAKE_SIGNAL) {
      // The intake gate needs the deck's Gamma TEMPLATE and (optionally) a
      // source artifact / Granola note — all opaque ids the user cannot
      // obtain in the dock. Only the run page can query the template
      // catalogue and the source pickers, so the dock is a visibility
      // surface here: it shows progress and links to the run page to launch
      // the deck, rather than demanding ids in a form (CL-2684).
      blocks.push(
        runPageLink(
          input.runId,
          "Set up the deck on the run page",
          "Pick the Gamma template and the source to build from on the run page.",
        ),
      );
    } else {
      // Any other gate needs input the dock can't collect — send the user to the
      // run page rather than POST an empty payload and corrupt the run.
      blocks.push(
        runPageLink(
          input.runId,
          "Continue on the run page",
          "This run needs input the dock can't collect yet — continue on the run page.",
        ),
      );
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
