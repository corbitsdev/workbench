import { describe, expect, test } from "bun:test";
import { buildAbPresetWorkflow } from "./builder";
import {
  abPresetDisplaySteps,
  abPresetHumanizeStepLabel,
} from "./display-steps";
import { QUALITY_PRESET, SPEED_PRESET, STANDARD_PRESET } from "./presets";

const PRESETS = [STANDARD_PRESET, SPEED_PRESET, QUALITY_PRESET] as const;

function labelForStepId(
  groups: ReturnType<typeof abPresetDisplaySteps>,
  stepId: string,
): string {
  const group = groups.find((g) => g.stepIds.includes(stepId));
  if (group === undefined) {
    throw new Error(`no display group for ${stepId}`);
  }
  return group.label;
}

describe("abPresetDisplaySteps", () => {
  for (const preset of PRESETS) {
    test(`${preset.kind}: covers every runtime step`, () => {
      const { workflow } = buildAbPresetWorkflow(preset);
      const declared = abPresetDisplaySteps(preset.variants.length);
      const declaredIds = new Set(declared.flatMap((g) => g.stepIds));
      for (const id of workflow.stepOrder) {
        expect(declaredIds.has(id)).toBe(true);
      }
    });

    test(`${preset.kind}: dock humanize matches catalog group labels`, () => {
      const { workflow } = buildAbPresetWorkflow(preset);
      const declared = abPresetDisplaySteps(preset.variants.length);
      for (const id of workflow.stepOrder) {
        expect(abPresetHumanizeStepLabel(id)).toBe(
          labelForStepId(declared, id),
        );
      }
    });
  }
});
