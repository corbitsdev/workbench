// User-facing step labels for curated A/B preset workflows. Single source for
// catalog displayFlow and dock progress (blocks.ts). Browser-safe: no workflow
// builder imports.

export type AbPresetDisplayStep = {
  key: string;
  label: string;
  stepIds: readonly string[];
};

export const AB_PRESET_EXEC_STEP_ID = /^exec\d+$/u;

export const AB_PRESET_STEP_LABELS: Record<string, string> = {
  config: "Prompt",
  quorum: "Check models",
  decision: "Decision",
  compose: "Compile",
  persist: "Save",
};

function execStepIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `exec${i}`);
}

function variantLabel(index: number): string {
  return `Variant ${index + 1}`;
}

export function abPresetHumanizeStepLabel(stepId: string): string {
  if (AB_PRESET_EXEC_STEP_ID.test(stepId)) {
    return variantLabel(Number(stepId.slice(4)));
  }
  const fixed = AB_PRESET_STEP_LABELS[stepId];
  if (fixed !== undefined) return fixed;
  return stepId.replace(/[-_]+/gu, " ").trim();
}

export function abPresetDisplaySteps(
  variantCount: number,
): readonly AbPresetDisplayStep[] {
  const execIds = execStepIds(variantCount);
  return [
    { key: "config", label: AB_PRESET_STEP_LABELS.config, stepIds: ["config"] },
    ...execIds.map((id, index) => ({
      key: id,
      label: variantLabel(index),
      stepIds: [id] as const,
    })),
    {
      key: "quorum",
      label: AB_PRESET_STEP_LABELS.quorum,
      stepIds: ["quorum"],
    },
    {
      key: "decision",
      label: AB_PRESET_STEP_LABELS.decision,
      stepIds: ["decision"],
    },
    {
      key: "compose",
      label: AB_PRESET_STEP_LABELS.compose,
      stepIds: ["compose"],
    },
    {
      key: "persist",
      label: AB_PRESET_STEP_LABELS.persist,
      stepIds: ["persist"],
    },
  ];
}
