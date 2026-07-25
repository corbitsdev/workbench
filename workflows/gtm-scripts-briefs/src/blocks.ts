import {
  blocksFromStepUI,
  type DockRunInput,
  type UIBlock,
} from "@workbench/blocks";
import { STEP_UI } from "./step-ui";

export { INTAKE_SIGNAL } from "./step-ui";

export interface GtmScriptsBriefsBlockInput extends DockRunInput {
  stepOutputs: Record<string, unknown>;
}

// Derives the dock's `UIBlock[]` from `STEP_UI` (`./step-ui.ts`) — the
// generic `blocksFromStepUI` resolver reproduces exactly what this file used
// to hand-build (proven by
// `packages/blocks/src/step-ui-gtm-scripts-briefs-equivalence.test.ts`), so
// the intake form's fields now come from the one list `STEP_UI` and the
// definition's `INTAKE_FIELDS` (`./index.ts`) both derive from, instead of a
// second, independently-maintained copy.
export function buildGtmScriptsBriefsBlocks(
  input: GtmScriptsBriefsBlockInput,
): UIBlock[] {
  return blocksFromStepUI(STEP_UI, input);
}
