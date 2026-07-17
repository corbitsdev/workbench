/**
 * Dock UIBlocks for the curated A/B preset workflows.
 *
 * The presets fix their models at definition time, so — unlike ab-compare-hitl —
 * the config gate collects ONLY the shared prompt. Each model runs as its own
 * `exec<i>` step; this builder derives the blind variant outputs and the winner
 * choice from those step outputs. The pick is BLIND: outputs and the choice
 * carry only "Variant N", never a model identity — the reveal lives on the run
 * page's saved artifact after the pick.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import {
  AB_PRESET_EXEC_STEP_ID,
  abPresetHumanizeStepLabel,
} from "./display-steps";

/** The config gate's `awaitSignal` name (matches the builder). */
export const CONFIG_SIGNAL = "ab-config";
/** The human-decision gate's `awaitSignal` name (matches the builder). */
export const DECISION_SIGNAL = "ab-decision";

export interface AbPresetBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId (value is the output, not `{ output }`). */
  stepOutputs: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type VariantStatus = "streaming" | "responded" | "no-response";

interface PresetVariant {
  label: string;
  content: string;
  status: VariantStatus;
}

// One entry per `exec<i>` step, in index order, with its blind label, the text
// it produced, and its lifecycle status: a lane not yet terminal is "streaming"
// (keeps its slot with a calm placeholder), a terminal lane with a reply is
// "responded", and a terminal empty/errored lane is "no-response" (kept in the
// grid as a gold marker, never dropped).
function readVariants(input: AbPresetBlockInput): PresetVariant[] {
  const execIds = input.steps
    .map((step) => step.stepId)
    .filter((id) => /^exec\d+$/u.test(id))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  return execIds.map((id, index) => {
    const step = input.steps.find((s) => s.stepId === id);
    const terminal = step !== undefined && TERMINAL_PHASES.has(step.phase);
    const output = input.stepOutputs[id];
    const reply = isRecord(output) ? output.reply : undefined;
    const failed = isRecord(output) && output.isError === true;
    const content = !failed && typeof reply === "string" ? reply : "";
    let status: VariantStatus;
    if (!terminal) {
      status = "streaming";
    } else if (failed || content.trim().length === 0) {
      status = "no-response";
    } else {
      status = "responded";
    }
    return { label: `Variant ${index + 1}`, content, status };
  });
}

function promptForm(): UIBlock {
  const input: FormField = {
    kind: "textarea",
    name: "input",
    label: "Shared prompt",
    placeholder: "The prompt to run across every model…",
    required: true,
  };
  return {
    kind: "form",
    prompt: "Enter the prompt to run blind across the preset's models.",
    signalName: CONFIG_SIGNAL,
    submitLabel: "Run comparison",
    fields: [input],
  };
}

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

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);

function execSteps(input: AbPresetBlockInput) {
  return input.steps.filter((step) => AB_PRESET_EXEC_STEP_ID.test(step.stepId));
}

// Every variant lane has reached a terminal phase — the point at which it is
// safe (and required) to reveal the blind outputs: results are shown only once
// ALL lanes finish, not incrementally as each returns.
function allExecsTerminal(input: AbPresetBlockInput): boolean {
  const execs = execSteps(input);
  return execs.length > 0 && execs.every((s) => TERMINAL_PHASES.has(s.phase));
}

export function buildAbPresetBlocks(input: AbPresetBlockInput): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => {
      // A `nonFatal` variant that errored still COMPLETES its step (it returns
      // an isError output), so its phase is "completed" — show it as failed in
      // the progress rail instead of a misleading green check.
      const output = input.stepOutputs[step.stepId];
      const variantFailed =
        AB_PRESET_EXEC_STEP_ID.test(step.stepId) &&
        isRecord(output) &&
        output.isError === true;
      return {
        state: variantFailed ? "failed" : progressStateForStepPhase(step.phase),
        label: abPresetHumanizeStepLabel(step.stepId),
      };
    });
    blocks.push({ kind: "progress", steps });
  }

  const variants = readVariants(input);
  const responded = variants.filter((v) => v.status === "responded");
  const lanesComplete = allExecsTerminal(input);

  // ONE unified comparison block carries every lane — live and final. The live
  // grid streams each cell in place (a streaming cell becomes responded without
  // remounting); a lane that never answers keeps its slot as a gold no-response
  // marker. The winner accent is suppressed until `status` is "final". Always
  // blind here — the model reveal lives on the run page's saved artifact.
  if (variants.length > 0) {
    blocks.push({
      kind: "comparison",
      status: lanesComplete ? "final" : "running",
      blind: true,
      result: {
        ranking: [],
        variants: variants.map((v) => ({
          label: v.label,
          content: v.content,
          status: v.status,
        })),
      },
    });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === CONFIG_SIGNAL) {
      blocks.push(promptForm());
    } else if (
      gate.signalName === DECISION_SIGNAL &&
      lanesComplete &&
      responded.length > 0
    ) {
      const labels = responded.map((v) => v.label);
      blocks.push({
        kind: "choice",
        prompt: "Pick the winning variant.",
        signalName: gate.signalName,
        promptBox: {
          placeholder: "Why did it win? (optional)",
          payloadKey: "rationale",
        },
        options: responded.map((variant) => ({
          id: variant.label,
          label: `${variant.label} wins`,
          value: variant.label,
          payload: decisionPayload(variant.label, labels),
        })),
      });
    } else {
      blocks.push(
        runPageLink(
          input.runId,
          "Open the run to continue",
          "This run needs input the dock can't collect here — continue on the run page.",
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
