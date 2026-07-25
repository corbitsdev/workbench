/**
 * Shared fallback for a gate whose interactive block is built from an EARLIER
 * step's output (CL-4284).
 *
 * Every migrated workflow's `blocks.ts` decodes a prior step's output and, on
 * success with content, renders the real choice/form/reviewList. What each one
 * did on failure was collapse three distinct causes into the same "open the
 * run to pick a transcript" run-page link:
 *   1. the producing step FAILED — there is no output coming, ever
 *   2. the producing step succeeded but produced nothing (a genuine empty
 *      result, e.g. zero Granola notes)
 *   3. the output exists but isn't readable on this surface (still parsing,
 *      a blob ref too large to inline, a malformed decode)
 *
 * Case 1 needs its own copy naming the failed step, not a link to a run page
 * that has nothing more to offer either. This is the one place that
 * distinguishes the three so every workflow renders them consistently.
 *
 * The failed step's `lastError.message` is whatever the underlying tool/step
 * threw — it can carry internal identifiers, stack fragments, or provider
 * hostnames (see `@workbench/ui`'s `workflow-run-error.ts`). It is never safe
 * to render raw, so it goes through the same `classifyRunError` the run-level
 * error already uses (`failedRunError`) before it reaches `detail`.
 */
import { humanizeStepId } from "@workbench/shared";
import { classifyRunError } from "@workbench/ui";
import type { DockRunStep, DockSurface } from "./run-dock-blocks";
import type { UIBlock } from "./ui-block";

/** Plain run-page link block — the dock's only escape hatch for a case its
 * primitives can't (yet) collect. */
export function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

/**
 * A run-page redirect that degrades to plain text when it would point at the
 * page already being viewed (CL-4284) — a "continue on the run page" link is
 * a dead end, not a redirect, when the run page itself renders it.
 */
export function runPageRedirectBlock(
  runId: string,
  title: string,
  description: string,
  surface?: DockSurface,
): UIBlock {
  if (surface === "run-page") return { kind: "text", text: description };
  return runPageLink(runId, title, description);
}

/** Whether a gate's data-dependent affordance has usable content — the
 * caller has already decoded the producing step's output and knows which. */
export type GateDataStatus =
  | "empty" // decoded fine, but there's nothing to act on
  | "unavailable"; // not decoded yet / malformed / not client-resolvable

export interface GateFallbackInput {
  runId: string;
  /** The stepId whose output this gate's affordance is built from. */
  producingStepId: string;
  steps: readonly DockRunStep[];
  dataStatus: GateDataStatus;
  surface?: DockSurface;
  /** Copy for the "succeeded but empty" case. */
  emptyMessage: string;
  /** Copy for the "unavailable" case, when it renders as a run-page link. */
  unavailableTitle: string;
  unavailableDescription: string;
}

/**
 * The single fallback a gate builder calls once it has determined its
 * producing step's output isn't usable (whatever the reason). Checks the
 * producing step's OWN phase first — a `failed` step always wins over the
 * caller's `dataStatus`, since a failed step never has real data to report as
 * merely "empty" or "unavailable".
 */
export function gateFallbackBlock(input: GateFallbackInput): UIBlock {
  const producingStep = input.steps.find(
    (step) => step.stepId === input.producingStepId,
  );

  if (producingStep?.phase === "failed") {
    return {
      kind: "error",
      message: `"${humanizeStepId(producingStep.stepId)}" failed, so this step can't continue.`,
      ...(producingStep.lastError?.message !== undefined
        ? {
            detail: classifyRunError(producingStep.lastError.message)
              .userMessage,
          }
        : {}),
    };
  }

  if (input.dataStatus === "empty") {
    return { kind: "text", text: input.emptyMessage };
  }

  return runPageRedirectBlock(
    input.runId,
    input.unavailableTitle,
    input.unavailableDescription,
    input.surface,
  );
}
