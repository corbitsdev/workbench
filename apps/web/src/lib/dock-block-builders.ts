import {
  blocksFromStepUIHints,
  dockRunBlocks,
  type DockRunInput,
  type StepUIHints,
  type UIBlock,
} from "@workbench/blocks";
import { buildAbPresetBlocks } from "@workbench/ab-compare-presets/blocks";
import { buildAttioTaskAgentBlocks } from "@workbench/workflow-attio-task-agent/blocks";
import { buildGammaBlocks } from "@workbench/workflow-gamma-presentation-creator/blocks";
import { buildGtmScriptsBriefsBlocks } from "@workbench/workflow-gtm-scripts-briefs/blocks";
import { STEP_UI_HINTS as last30daysStepUIHints } from "@workbench/workflow-last30days-research";
import { buildPainPointCollateralBlocks } from "@workbench/workflow-pain-point-collateral/blocks";
import { buildMultiSourceCollateralBlocks } from "@workbench/workflow-multi-source-collateral/blocks";
import { buildRedditOpportunityScannerBlocks } from "@workbench/workflow-reddit-opportunity-scanner/blocks";
import { buildSumbleAccountIntelBlocks } from "@workbench/workflow-sumble-account-intel/blocks";
import { buildCompetitorAnalysisBlocks } from "@workbench/workflow-competitor-analysis/blocks";

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
  "gtm-scripts-briefs": buildGtmScriptsBriefsBlocks,
  "pain-point-collateral": buildPainPointCollateralBlocks,
  "multi-source-collateral": buildMultiSourceCollateralBlocks,
  "reddit-opportunity-scanner": buildRedditOpportunityScannerBlocks,
  "sumble-account-intel": buildSumbleAccountIntelBlocks,
  "competitor-analysis": buildCompetitorAnalysisBlocks,
};

// Per-kind declarative step -> component mappings (CL-3923). A workflow on
// this path declares which block renders each `awaitSignal` gate as data
// (`StepUIHints`, colocated with its step definitions) instead of writing a
// bespoke `DockBlockBuilder` function above — `blocksFromStepUIHints` is the
// one generic resolver every hint-driven workflow shares.
const stepUIHints: Record<string, StepUIHints> = {
  "last30days-research": last30daysStepUIHints,
};

export function buildDockBlocks(
  kind: string,
  input: DockBlockBuilderInput,
): UIBlock[] {
  const builder = builders[kind];
  if (builder !== undefined) return builder(input);
  const hints = stepUIHints[kind];
  if (hints !== undefined) return blocksFromStepUIHints(hints, input);
  return dockRunBlocks(input);
}
