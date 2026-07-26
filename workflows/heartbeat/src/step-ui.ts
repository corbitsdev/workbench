// Workflow-local `STEP_UI` contract — the dock-rendering hint map every
// migrated workflow may export, formerly `packages/workbench-shared/src/
// step-ui.ts`'s `StepUISchema`/`assertStepUIKeysMatchStepIds`/
// `assertGateStepsHaveStepUIEntry`. Duplicated here (rather than depending on
// `@workbench/shared`) since heartbeat is gate-free: it declares no
// `awaitSignal` step, so it needs only the `title` field — no gate/input
// vocabulary at all. The host (`@workbench/blocks`' `blocksFromStepUI`) reads
// this export by convention (structural shape, not a shared type import).
import {
  heartbeatIntakeStepKey,
  WIRED_BRIEF_SOURCES,
} from "./heartbeat-shared";

export interface StepUIEntry {
  /** Short human title shown in the dock's progress row / run timeline. */
  title?: string;
}

export type StepUI = Record<string, StepUIEntry>;

export const STEP_UI: StepUI = {
  ...Object.fromEntries(
    WIRED_BRIEF_SOURCES.map((source) => [
      heartbeatIntakeStepKey(source.key),
      { title: `Fetch ${source.label}` },
    ]),
  ),
  "merge-sources": { title: "Merge your sources" },
  brief: { title: "Write your brief" },
  title: { title: "Format the brief title" },
  document: { title: "Compose the brief document" },
  persist: { title: "Save to your workbench" },
  "notify-prep": { title: "Prepare delivery" },
  notify: { title: "Send to your inbox" },
};

/**
 * Build-time guard: every `STEP_UI` key must name a real step id in the
 * workflow's own `defineWorkflow({ steps: {...} })`.
 */
export function assertStepUIKeysMatchStepIds(
  stepUI: StepUI,
  stepIds: readonly string[],
): void {
  const known = new Set(stepIds);
  const unknownKeys = Object.keys(stepUI).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `STEP_UI declares entries for unknown step id(s): ${unknownKeys.join(", ")}. Every STEP_UI key must match a real step id in the workflow definition.`,
    );
  }
}

/**
 * Build-time guard: every GATE step (an `awaitSignal` primitive) must have a
 * `STEP_UI` entry. Heartbeat declares no `awaitSignal` step at all, so
 * `gateStepIds` is always empty and this call is a trivial no-op — kept so a
 * future gate added to this workflow can't silently ship without dock copy.
 */
export function assertGateStepsHaveStepUIEntry(
  stepUI: StepUI,
  gateStepIds: readonly string[],
): void {
  const missing = gateStepIds.filter((stepId) => stepUI[stepId] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `STEP_UI is missing entries for gate step id(s): ${missing.join(", ")}. Every awaitSignal (gate) step needs a STEP_UI entry.`,
    );
  }
}
