/**
 * The generic `STEP_UI` derivation —
 *
 * `STEP_UI` (see `@workbench/shared`'s `step-ui.ts`) is a workflow's optional,
 * declarative step -> UI map, colocated with its native `defineWorkflow(...)`.
 * `blocksFromStepUI` is the one host-side resolver that turns a run's
 * log-derived state plus that map into the same `UIBlock[]` shape the dock
 * has always rendered — reusing the exact generic helpers every migrated
 * workflow's `blocks.ts` already calls (`pendingGateForRun`,
 * `progressStateForStepPhase`), never reimplementing them. A step absent from
 * the map, or a workflow with no `STEP_UI` export, renders with the same
 * defaults `dockRunBlocks` produces today.
 */
import type { StepUI, StepUIEntry, StepUIInputField } from "@workbench/shared";
import { pendingGateForRun } from "./conversation-gates";
import type { DockRunInput, DockRunStep } from "./run-dock-blocks";
import { progressStateForStepPhase } from "./run-dock-blocks";
import { isUIBlock } from "./ui-block";
import type {
  FormField,
  FormFieldOption,
  ProgressStep,
  UIBlock,
} from "./ui-block";

export interface StepUIRunInput extends DockRunInput {
  /** Decoded per-step outputs, keyed by step id, for `output`-declared steps. */
  stepOutputs?: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function toFormFieldOption(option: {
  value: string;
  label: string;
}): FormFieldOption {
  return { value: option.value, label: option.label };
}

/**
 * Converts a `STEP_UI` input field into the `FormField` the `form` block
 * renders. `select`/`multiSelect` require `options` — a `STEP_UI` entry
 * declaring one without options is a genuine authoring error, so this throws
 * rather than silently rendering an empty picker (no stubs).
 */
function toFormField(field: StepUIInputField): FormField {
  const base = {
    name: field.name,
    ...(field.label !== undefined ? { label: field.label } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
  };
  switch (field.kind) {
    case "text":
    case "textarea":
      return {
        kind: field.kind,
        ...base,
        ...(field.placeholder !== undefined
          ? { placeholder: field.placeholder }
          : {}),
        ...(typeof field.defaultValue === "string"
          ? { defaultValue: field.defaultValue }
          : {}),
      };
    case "number":
      return {
        kind: "number",
        ...base,
        ...(field.placeholder !== undefined
          ? { placeholder: field.placeholder }
          : {}),
        ...(typeof field.defaultValue === "number"
          ? { defaultValue: field.defaultValue }
          : {}),
      };
    case "select":
    case "multiSelect":
      if (field.options === undefined) {
        throw new Error(
          `STEP_UI input field "${field.name}" of kind "${field.kind}" declares no options`,
        );
      }
      return {
        kind: field.kind,
        ...base,
        options: field.options.map(toFormFieldOption),
      };
  }
}

type OutputBlockKind = Extract<
  UIBlock["kind"],
  "reviewList" | "table" | "markdown" | "list" | "card" | "text"
>;

const OUTPUT_BLOCK_KINDS = new Set<OutputBlockKind>([
  "reviewList",
  "table",
  "markdown",
  "list",
  "card",
  "text",
]);

/**
 * Resolves `entry.output.block` (e.g. `"reviewList"`) to the UIBlock it
 * stamps: the step's own output is spread onto `{ kind, title }` and
 * validated as a real `UIBlock` of that kind. Every registered kind's
 * shape (rows/columns/items/etc.) must already come pre-shaped from the
 * step's own output — this registry only picks the discriminant and
 * validates, it does not reshape domain data (that stays workflow-owned).
 */
function resolveOutputBlock(entry: StepUIEntry, output: unknown): UIBlock {
  const blockKind = entry.output?.block;
  if (blockKind === undefined) {
    throw new Error("resolveOutputBlock requires entry.output.block");
  }
  if (!OUTPUT_BLOCK_KINDS.has(blockKind as OutputBlockKind)) {
    throw new Error(
      `STEP_UI declares unknown output block kind "${blockKind}"`,
    );
  }
  if (typeof output !== "object" || output === null) {
    throw new Error(
      `STEP_UI output block "${blockKind}" requires an object-shaped step output`,
    );
  }
  const candidate = {
    ...output,
    kind: blockKind,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
  };
  if (!isUIBlock(candidate)) {
    throw new Error(
      `STEP_UI output declared block kind "${blockKind}" but the step's output does not match that block's shape`,
    );
  }
  return candidate;
}

function findGatingStep(
  steps: readonly DockRunStep[],
  signalName: string,
): DockRunStep | undefined {
  return steps.find(
    (step) =>
      step.phase === "awaiting-signal" &&
      step.awaitingSignalName === signalName,
  );
}

function gateBlockForEntry(
  entry: StepUIEntry | undefined,
  signalName: string,
): UIBlock {
  if (entry?.input !== undefined) {
    return {
      kind: "form",
      ...(entry.prompt !== undefined
        ? { prompt: entry.prompt }
        : entry.title !== undefined
          ? { prompt: entry.title }
          : {}),
      signalName,
      ...(entry.submitLabel !== undefined
        ? { submitLabel: entry.submitLabel }
        : {}),
      fields: entry.input.map(toFormField),
    };
  }
  return {
    kind: "choice",
    prompt: "This run is waiting for your input.",
    signalName,
    options: [{ id: "continue", label: "Continue", value: "" }],
  };
}

/**
 * Derives a run's dock `UIBlock[]` from its `STEP_UI` map: progress (titles
 * from `STEP_UI`, falling back to a humanized step id), the pending gate
 * (a `form` when the gating step declares `input`, else the generic
 * single-button `choice` `dockRunBlocks` already renders), completed steps'
 * declared `output` blocks, then the terminal error/link block — the exact
 * shape `dockRunBlocks`/`blocksFromStepUIHints` already produce, just driven
 * by a richer per-step map instead of a gate-only one.
 */
export function blocksFromStepUI(
  stepUI: StepUI,
  run: StepUIRunInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (run.steps.length > 0) {
    const steps: ProgressStep[] = run.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: stepUI[step.stepId]?.title ?? humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: run.runId, steps: run.steps });
  if (gate !== null) {
    const gatingStep = findGatingStep(run.steps, gate.signalName);
    const entry =
      gatingStep !== undefined ? stepUI[gatingStep.stepId] : undefined;
    blocks.push(gateBlockForEntry(entry, gate.signalName));
  }

  for (const step of run.steps) {
    const entry = stepUI[step.stepId];
    if (entry?.output === undefined) continue;
    if (step.phase !== "completed") continue;
    const output = run.stepOutputs?.[step.stepId];
    if (output === undefined) continue;
    blocks.push(resolveOutputBlock(entry, output));
  }

  if (run.phase === "failed" && run.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: run.errorMessage });
  }

  if (run.phase === "completed" && run.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: run.completedLink.url,
      title: run.completedLink.title,
      ...(run.completedLink.description !== undefined
        ? { description: run.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
