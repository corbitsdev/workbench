import {
  dockRunBlocks,
  type DockRunInput,
  type UIBlock,
} from "@workbench/blocks";
import { buildAbPresetBlocks } from "@workbench/ab-compare-presets/blocks";
import { buildAttioTaskAgentBlocks } from "@workbench/workflow-attio-task-agent/blocks";
import { buildGammaBlocks } from "@workbench/workflow-gamma-presentation-creator/blocks";
import { buildLast30daysBlocks } from "@workbench/workflow-last30days-research/blocks";
import { buildPainPointCollateralBlocks } from "@workbench/workflow-pain-point-collateral/blocks";
import { buildRedditOpportunityScannerBlocks } from "@workbench/workflow-reddit-opportunity-scanner/blocks";
import { buildSumbleAccountIntelBlocks } from "@workbench/workflow-sumble-account-intel/blocks";

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
  "ab-compare-quality": buildAbPresetBlocks,
  "ab-compare-speed": buildAbPresetBlocks,
  "ab-compare-standard": buildAbPresetBlocks,
  "attio-task-agent": buildAttioTaskAgentBlocks,
  "gamma-presentation-creator": buildGammaBlocks,
  "last30days-research": buildLast30daysBlocks,
  "pain-point-collateral": buildPainPointCollateralBlocks,
  "reddit-opportunity-scanner": buildRedditOpportunityScannerBlocks,
  "sumble-account-intel": buildSumbleAccountIntelBlocks,
};

export function buildDockBlocks(
  kind: string,
  input: DockBlockBuilderInput,
): UIBlock[] {
  const builder = builders[kind];
  if (builder !== undefined) return builder(input);
  return dockRunBlocks(input);
}
