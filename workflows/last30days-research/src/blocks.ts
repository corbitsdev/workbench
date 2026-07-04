/**
 * The last30days-research workflow's own dock blocks (CL-2765).
 *
 * Migrates the single `intake` gate off the bespoke `ui.tsx` panel and onto the
 * shared UIBlock surface, following the ab-compare-hitl / gamma pattern: this
 * builder derives the run's dock content — a progress block and, at the pending
 * `intake` gate, a `form` collecting the research topic (required) and an
 * optional focus — from the run's log-derived state. The `ui.tsx` panel stays as
 * the run-page strangler fallback.
 *
 * The form emits `{ topic, focus }` VERBATIM; the panel's former client-side
 * `query = focus || topic` / `days: 30` derivation now lives server-side in
 * `normalizeIntake` (@workbench/last30days-core), so a block-driven run and a
 * panel-driven run hand the pipeline the identical `{ topic, query, days }`.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";

/** The intake gate's `awaitSignal` name (matches the workflow def). */
export const INTAKE_SIGNAL = "intake";

export interface Last30daysBlockInput extends DockRunInput {
  /**
   * Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces.
   * Unused today — the one gate collects fresh input rather than reflecting a
   * prior step's output — but carried for parity with the other builders' shape.
   */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function intakeForm(signalName: string): UIBlock {
  const topic: FormField = {
    kind: "text",
    name: "topic",
    label: "Topic",
    placeholder: "e.g. AI coding agents for GTM teams",
    required: true,
  };
  const focus: FormField = {
    kind: "textarea",
    name: "focus",
    label: "Focus (optional)",
    placeholder: "Narrow the query or angle",
  };
  return {
    kind: "form",
    prompt:
      "What should we research? We scan the last 30 days across Hacker News, GitHub, web, Reddit, X, YouTube, and Polymarket, then synthesize a cited brief.",
    signalName,
    submitLabel: "Start research",
    fields: [topic, focus],
  };
}

export function buildLast30daysBlocks(input: Last30daysBlockInput): UIBlock[] {
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
      // The block-driven intake form (CL-2765): topic (required) + focus
      // (optional), emitted verbatim as the `{ topic, focus }` resume payload the
      // /resume boundary validates against Last30daysIntakePayloadSchema.
      blocks.push(intakeForm(gate.signalName));
    } else {
      // No other gate exists in this workflow, but guard defensively: send the
      // user to the run page rather than POST an empty payload and corrupt the run.
      blocks.push({
        kind: "link",
        url: `/workflows/${input.runId}`,
        title: "Continue on the run page",
        description:
          "This run needs input the dock can't collect yet — continue on the run page.",
      });
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
