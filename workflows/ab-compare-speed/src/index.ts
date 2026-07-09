import {
  buildAbPresetWorkflow,
  SPEED_PRESET,
} from "@workbench/ab-compare-presets";

const built = buildAbPresetWorkflow(SPEED_PRESET);

export const workflow = built.workflow;
export const label = built.label;
export const description = built.description;
export const kind = built.kind;
export const ARTIFACT_KIND = built.ARTIFACT_KIND;
