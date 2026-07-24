import { awaitSignal, defineWorkflow } from "@intx/workflow";
import type { Primitive, RetryPolicy } from "@intx/workflow";
import { deterministicToolStep, agentStep } from "@workbench/agents";
import { AB_PRESET_EXECUTE_SYSTEM_PROMPT } from "./prompt";
import type { AbPresetConfig } from "./presets";

// The persisted artifact kind — shared with the other A/B workflows so the
// renderer routes every comparison through one ComparisonView.
export const ARTIFACT_KIND = "ab-comparison";

// Each variant retries transient failures on its pinned source. Once retries
// are exhausted the step fails, which fails the whole run — a variant no
// longer degrades to a recorded skip (product call: rerun the comparison
// rather than silently dropping a dead model; the accepted cost is the
// inference already spent on the sibling variants that succeeded).
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
 *   exec<i>   agentStep per FIXED model (not a `map`, which would collapse
 *             every variant onto one pinned source). Each retries transient
 *             failures on its pinned source; once retries are exhausted the
 *             step is terminally failed. No degrade-to-skip: the engine's DAG
 *             dependency is "terminal", not "succeeded", so quorum/decision/
 *             compose still run off the survivors — but a permanently failed
 *             step marks the WHOLE RUN failed regardless of how the rest of
 *             the DAG turns out, so a dead variant always means rerun the
 *             comparison, never a silently-dropped lane.
 *   quorum    ab_preset_quorum — throws (also failing the run) when too few
 *             variants produced a non-empty answer, so the human is never
 *             shown a decision gate that can't stand — whether the shortfall
 *             came from a hard failure (missing output) or a model that
 *             "succeeded" with an empty completion.
 *   decision  awaitSignal — the human reviews the blind outputs and ranks them.
 *   compose   ab_preset_compose — folds the fixed variant metadata + each
 *             exec output + the decision into one ab-comparison payload.
 *   persist   artifact_create — saves the comparison.
 */
export function buildAbPresetWorkflow(config: AbPresetConfig): BuiltAbPreset {
  const execIds = config.variants.map((_, index) => `exec${index}`);

  const steps: Record<string, Primitive> = {
    config: awaitSignal({ name: "ab-config" }),
  };

  config.variants.forEach((variant, index) => {
    steps[execIds[index]!] = agentStep({
      id: execIds[index]!,
      title: variant.label,
      systemPrompt: AB_PRESET_EXECUTE_SYSTEM_PROMPT,
      model: variant.model,
      ...(variant.provider !== undefined ? { provider: variant.provider } : {}),
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

  // Runs off however many variant steps settled (the engine still runs
  // dependents of a terminally-failed step): fails the run before the human
  // is shown a decision that cannot stand, whether a variant hard-failed
  // (missing output) or "succeeded" with an empty completion. A permanently
  // failed variant already dooms the run's terminalStatus regardless of what
  // this step decides — the value here is failing fast on the shortfall
  // instead of letting the human pick from a decision gate that will be
  // reported failed either way.
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
