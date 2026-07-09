import { awaitSignal, defineWorkflow } from "@intx/workflow";
import type { Primitive, RetryPolicy } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { AB_PRESET_EXECUTE_SYSTEM_PROMPT } from "./prompt";
import type { AbPresetConfig } from "./presets";

// The persisted artifact kind — shared with the other A/B workflows so the
// renderer routes every comparison through one ComparisonView.
export const ARTIFACT_KIND = "ab-comparison";

// Each variant retries transient failures on its pinned source before the
// non-fatal degrade lets the quorum drop it.
const VARIANT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
};

export interface BuiltAbPreset {
  kind: string;
  label: string;
  description: string;
  ARTIFACT_KIND: string;
  workflow: ReturnType<typeof defineWorkflow>;
}

/**
 * Build one curated-preset A/B workflow from a fixed variant line-up.
 *
 *   config    awaitSignal — collects only the shared prompt ({ input }).
 *   exec<i>   inlineInferenceStep per FIXED model (not a `map`, which would
 *             collapse every variant onto one pinned source). Each is nonFatal
 *             + retry so one dead variant does not fail the run.
 *   decision  awaitSignal — the human reviews the blind outputs and ranks them.
 *   compose   ab_preset_compose — enforces the >=2 quorum and folds the fixed
 *             variant metadata + each exec output + the decision into one
 *             ab-comparison payload.
 *   persist   artifact_create — saves the comparison.
 */
export function buildAbPresetWorkflow(config: AbPresetConfig): BuiltAbPreset {
  const execIds = config.variants.map((_, index) => `exec${index}`);

  const steps: Record<string, Primitive> = {
    config: awaitSignal({ name: "ab-config" }),
  };

  config.variants.forEach((variant, index) => {
    steps[execIds[index]!] = inlineInferenceStep({
      id: execIds[index]!,
      title: variant.label,
      systemPrompt: AB_PRESET_EXECUTE_SYSTEM_PROMPT,
      model: variant.model,
      nonFatal: true,
      retry: VARIANT_RETRY,
      input: { from: "steps.config.output.input" },
      after: ["config"],
    });
  });

  // The fixed variant metadata (blind label + real model) both the quorum gate
  // and the compose step read, threaded in as a literal since the presets have
  // no `config`-variants step.
  const variantsLiteral = {
    literal: {
      __presetVariants: config.variants.map((v) => ({
        label: v.label,
        model: v.model,
      })),
    },
  };

  // Enforce the quorum BEFORE the human is asked to pick: once every variant lane
  // is terminal, fail the run if too few produced an answer, so a doomed
  // comparison never reaches the decision gate.
  steps.quorum = deterministicToolStep({
    id: "quorum",
    title: "Check enough models answered",
    tool: "ab_preset_quorum",
    input: { merge: [{ from: "steps" }, variantsLiteral] },
    after: execIds,
  });

  steps.decision = awaitSignal({ name: "ab-decision", after: ["quorum"] });

  steps.compose = deterministicToolStep({
    id: "compose",
    title: "Compile the comparison",
    tool: "ab_preset_compose",
    input: { merge: [{ from: "steps" }, variantsLiteral] },
    after: ["decision"],
  });

  steps.persist = deterministicToolStep({
    id: "persist",
    title: "Save the comparison",
    tool: "artifact_create",
    input: { from: "steps.compose.output" },
    argMap: {
      content: { from: "content" },
      title: { literal: `${config.label} Results` },
      kind: { literal: ARTIFACT_KIND },
    },
    after: ["compose"],
  });

  return {
    kind: config.kind,
    label: config.label,
    description: config.description,
    ARTIFACT_KIND,
    workflow: defineWorkflow({
      id: config.kind,
      trigger: { type: "manual" },
      steps,
    }),
  };
}
