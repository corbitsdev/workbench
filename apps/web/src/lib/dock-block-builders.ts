import {
  dockRunBlocks,
  type DockRunInput,
  type UIBlock,
} from "@workbench/chat";
import { buildAbCompareHitlBlocks } from "@workbench/workflow-ab-compare-hitl/blocks";
import { buildAttioTaskAgentBlocks } from "@workbench/workflow-attio-task-agent/blocks";
import { buildGammaBlocks } from "@workbench/workflow-gamma-presentation-creator/blocks";

// Per-kind dock block builders (CL-2683). A migrated workflow supplies its own
// builder — deriving richer, kind-specific UIBlocks (results tables, typed
// choices) from the run's state plus decoded step outputs. Every other kind
// falls through to the generic `dockRunBlocks` synthesis (the strangler
// fallback: progress + a generic gate choice + link/error). This is the block
// analogue of the `loadWorkflowUI` panel registry, and like it keeps other
// workflows on the pre-existing path untouched.
export type DockBlockBuilderInput = DockRunInput & {
  stepOutputs: Record<string, unknown>;
};

type DockBlockBuilder = (input: DockBlockBuilderInput) => UIBlock[];

const builders: Record<string, DockBlockBuilder> = {
  "ab-compare-hitl": buildAbCompareHitlBlocks,
  "attio-task-agent": buildAttioTaskAgentBlocks,
  "gamma-presentation-creator": buildGammaBlocks,
};

export function buildDockBlocks(
  kind: string,
  input: DockBlockBuilderInput,
): UIBlock[] {
  const builder = builders[kind];
  if (builder !== undefined) return builder(input);
  return dockRunBlocks(input);
}
