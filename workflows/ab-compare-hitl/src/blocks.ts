/**
 * The ab-compare-hitl workflow's own dock blocks (CL-2683).
 *
 * The first workflow migrated off the bespoke `ui.tsx` panel and onto the shared
 * UIBlock surface: this builder derives the run's dock content — a progress
 * block, the blind variant outputs, and a winner choice at the human-decision
 * gate — from the run's log-derived state plus its decoded step outputs. It
 * renders through the shared `UIBlockView`; no ab-compare-hitl panel code runs on
 * this path. Un-migrated workflows keep the generic `dockRunBlocks` synthesis
 * (strangler fallback in the dock registry).
 *
 * The pick is BLIND by construction: the pre-decision output blocks and the
 * winner choice never carry a provider/model identity string — the reveal lives
 * on the run page after the decision, exactly as the old panel's `blind` flag
 * enforced. Reuses `composeComparisonResult` so the outputs and the winner
 * choice's ranking are built from the exact same fold the persisted artifact
 * uses — the dock preview and the saved comparison can never disagree.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type FormFieldOption,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import { composeComparisonResult } from "@workbench/tools-ab-compare";
import { AB_COMPARISON_PROVIDER_PLUGINS } from "./models";

// Plain-language labels for the provider plugins the config form offers. The
// option VALUE is the plugin id the compose step reveals as the variant's
// provider; the label is what the human reads (CL-2684).
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible (OpenCode Zen)",
  openai: "OpenAI",
  "google-genai": "Google Gemini",
};

function providerFieldOptions(): FormFieldOption[] {
  return AB_COMPARISON_PROVIDER_PLUGINS.map((plugin) => ({
    value: plugin,
    label: PROVIDER_LABELS[plugin] ?? plugin,
  }));
}

// The block-driven config form (CL-2684): a repeatable group of provider+model
// variants plus the shared prompt. Its submitted `Record<name, value>` payload
// is `{ variants: [{ providerName, model }], input }` verbatim — exactly the
// `ab-config` gate's shape (AbConfigPayloadSchema), which the /resume boundary
// validates. Two variants are seeded (min 2) because a comparison needs at
// least two; `input` is a required textarea so the run cannot start with no
// prompt. Model is a free-text field: the dock has no tenant credential list to
// derive a per-provider model menu from, so the human types the model id (the
// blind reveal shows provider + model after the pick).
function configForm(signalName: string): UIBlock {
  const variants: FormField = {
    kind: "group",
    name: "variants",
    label: "Variants to compare",
    addLabel: "Add a variant",
    min: 2,
    max: 6,
    fields: [
      {
        kind: "select",
        name: "providerName",
        label: "Provider",
        required: true,
        options: providerFieldOptions(),
      },
      {
        kind: "text",
        name: "model",
        label: "Model",
        placeholder: "e.g. claude-opus-4-8",
        required: true,
      },
    ],
  };
  const input: FormField = {
    kind: "textarea",
    name: "input",
    label: "Shared prompt",
    placeholder: "The prompt to run across every variant…",
    required: true,
  };
  return {
    kind: "form",
    prompt: "Set up the comparison: pick the variants and the shared prompt.",
    signalName,
    submitLabel: "Run comparison",
    fields: [variants, input],
  };
}

/** The human-decision gate's `awaitSignal` name (matches the workflow def). */
export const DECISION_SIGNAL = "ab-decision";
/** The config gate's `awaitSignal` name (matches the workflow def). */
export const CONFIG_SIGNAL = "ab-config";

export interface AbCompareBlockInput extends DockRunInput {
  /**
   * Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces
   * (the value is the step's output, NOT wrapped in `{ output }`).
   */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

// composeComparisonResult reads `steps[id].output`; the log fold hands us the
// output directly, so wrap each entry back into the `{ output }` step shape.
function asStepsTree(
  stepOutputs: Record<string, unknown>,
): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const [stepId, output] of Object.entries(stepOutputs)) {
    tree[stepId] = { output };
  }
  return tree;
}

// A ranking that puts the picked variant first and preserves the display order
// for the rest — exactly the shape `ab_comparison_compose` reads as the human
// decision (`{ ranking: [{ rank, label }] }`).
function decisionPayload(
  winnerLabel: string,
  labels: string[],
): { ranking: { rank: number; label: string }[] } {
  const ranking = [{ rank: 1, label: winnerLabel }];
  let nextRank = 2;
  for (const label of labels) {
    if (label === winnerLabel) continue;
    ranking.push({ rank: nextRank, label });
    nextRank += 1;
  }
  return { ranking };
}

function executeInFlight(input: AbCompareBlockInput): boolean {
  const execute = input.steps.find((step) => step.stepId === "execute");
  return execute !== undefined && execute.phase === "in-flight";
}

export function buildAbCompareHitlBlocks(
  input: AbCompareBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const composed = composeComparisonResult(asStepsTree(input.stepOutputs));
  const hasOutputs = composed.variants.some(
    (variant) => variant.content.trim().length > 0,
  );

  // Blind variant outputs: one expandable, scrollable, markdown-rendered card per
  // variant — never a truncated cell — and NEVER the provider/model (CL-2683).
  // The reveal is on the run page after the pick.
  if (composed.variants.length > 0 && hasOutputs) {
    for (const variant of composed.variants) {
      blocks.push({
        kind: "document",
        title: variant.label,
        source: variant.content,
      });
    }
  } else if (executeInFlight(input)) {
    // Skeleton placeholder holding the space the outputs will fill, so the card
    // does not jump when execute finishes.
    blocks.push({
      kind: "text",
      text: "Running the variants — outputs will appear here.",
    });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === DECISION_SIGNAL) {
      if (composed.variants.length > 0 && hasOutputs) {
        const labels = composed.variants.map((variant) => variant.label);
        blocks.push({
          kind: "choice",
          prompt: "Pick the winning variant.",
          signalName: gate.signalName,
          // The rationale the run-page panel collects on the winner — captured
          // here via the choice's prompt-box and folded onto the rank-1 entry by
          // the compose tool, so the dock and the panel persist equivalent
          // artifacts (CL-2683).
          promptBox: {
            placeholder: "Why did it win? (optional)",
            payloadKey: "rationale",
          },
          options: composed.variants.map((variant) => ({
            id: variant.label,
            label: `${variant.label} wins`,
            value: variant.label,
            payload: decisionPayload(variant.label, labels),
          })),
        });
      } else {
        // The blind outputs are not resolvable in the dock (stored out of line,
        // or not yet available). Do NOT invite a pick with nothing to compare —
        // send the user to the run page instead of rendering an actionable choice.
        blocks.push(
          runPageLink(
            input.runId,
            "Open the run to pick a winner",
            "The variant outputs aren't available here — review and choose on the run page.",
          ),
        );
      }
    } else if (gate.signalName === CONFIG_SIGNAL) {
      // The config gate is now block-driven (CL-2684): a form collects the
      // provider/model variants + the shared prompt and POSTs the structured
      // `{ variants, input }` the `ab-config` gate requires (validated at the
      // /resume boundary). The run-page panel stays as the strangler fallback.
      blocks.push(configForm(gate.signalName));
    } else {
      // Any other non-decision gate requires a structured payload the dock
      // cannot collect — send the user to the run page rather than POST an empty
      // payload and corrupt the run.
      blocks.push(
        runPageLink(
          input.runId,
          "Continue on the run page",
          "This run needs input the dock can't collect yet — continue on the run page.",
        ),
      );
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
