/**
 * Declarative step -> component mapping (CL-3923).
 *
 * A workflow's hand-written `blocks.ts` builder (see e.g. the pre-CL-3923
 * `last30days-research/src/blocks.ts`) existed for exactly one reason across
 * every migrated workflow: to say, in code, "when the run parks on THIS
 * `awaitSignal` gate, render THIS form/choice/multiSelect/reviewList block."
 * Everything else in those builders — the progress block, the terminal
 * error/link block, the pending-gate lookup — was identical boilerplate
 * copy-pasted from `dockRunBlocks`.
 *
 * `StepUIHints` replaces the bespoke function with data: a map from a step's
 * `awaitSignal` name to the UIBlock that should render at that gate, typed as
 * everything the gate block needs EXCEPT `signalName` (recovered from the
 * run's log-derived state, never authored) and `kind` discrimination lives on
 * the hint itself. A workflow package colocates this map with its step
 * definitions (next to `defineWorkflow(...)`) instead of writing a builder
 * function. `blocksFromStepUIHints` is the one generic resolver every migrated
 * workflow shares — the same role `dockRunBlocks` already plays for
 * unmigrated ones, just gate-aware.
 *
 * Standard step shapes covered (validated against the 18 `workflows/*`
 * packages' `awaitSignal` gates and their `ui.tsx`/`blocks.ts` panels):
 *   - a single-turn intake/config `form` (last30days-research, ab-compare family)
 *   - a decision `choice` (attio-task-agent review/sync-approval style gates)
 *   - an N-of-M `multiSelect`
 *   - a per-record `reviewList` (pain-point-collateral / multi-source-collateral
 *     style piece approval)
 * A gate with no declared hint falls back to the generic single-button
 * `choice` `dockRunBlocks` already renders — the strangler default, unchanged.
 */
import { pendingGateForRun } from "./conversation-gates";
import type { DockRunInput } from "./run-dock-blocks";
import { progressStateForStepPhase } from "./run-dock-blocks";
import type { ProgressStep, UIBlock } from "./ui-block";

/**
 * The declarative gate hint vocabulary. Each variant is the corresponding
 * `UIBlock` gate kind minus `signalName` — the resolver stamps that on from
 * the run's live pending-gate lookup, so a hint never hardcodes it and can't
 * drift from the step definition's actual `awaitSignal` name.
 */
export type GateUIHint =
  | Omit<Extract<UIBlock, { kind: "form" }>, "signalName">
  | Omit<Extract<UIBlock, { kind: "choice" }>, "signalName">
  | Omit<Extract<UIBlock, { kind: "multiSelect" }>, "signalName">
  | Omit<Extract<UIBlock, { kind: "reviewList" }>, "signalName">;

/**
 * A workflow's declarative step -> component mapping: `awaitSignal` name to
 * the block that renders at that gate. Colocate this with the step
 * definition (e.g. exported alongside `workflow = defineWorkflow(...)`) —
 * one map per workflow, no per-workflow builder function required for
 * standard gate shapes.
 */
export type StepUIHints = Record<string, GateUIHint>;

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function stampSignalName(hint: GateUIHint, signalName: string): UIBlock {
  return { ...hint, signalName } as UIBlock;
}

/**
 * The generic resolver: progress block over the run's steps, then — at a
 * pending gate — the declared hint for that gate's signal (falling back to
 * the plain single-button `choice` `dockRunBlocks` renders when no hint is
 * declared for that signal), then a terminal error/link block. Mirrors
 * `dockRunBlocks` exactly except the gate block is data-driven instead of
 * hardcoded, so a migrated workflow's dock output is unchanged in shape from
 * its former hand-written builder — only the mapping moved from code to data.
 */
export function blocksFromStepUIHints(
  hints: StepUIHints,
  run: DockRunInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (run.steps.length > 0) {
    const steps: ProgressStep[] = run.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: run.runId, steps: run.steps });
  if (gate !== null) {
    const hint = hints[gate.signalName];
    if (hint !== undefined) {
      blocks.push(stampSignalName(hint, gate.signalName));
    } else {
      blocks.push({
        kind: "choice",
        prompt: "This run is waiting for your input.",
        signalName: gate.signalName,
        options: [{ id: "continue", label: "Continue", value: "" }],
      });
    }
  }

  if (run.phase === "failed" && run.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: run.errorMessage });
  }

  if (run.phase === "completed" && run.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: run.completedLink.url,
      title: run.completedLink.title,
      ...(run.completedLink.description !== undefined
        ? { description: run.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
