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
 *
 * A gate's block comes from one of three places, in priority order:
 *   1. `entry.input` — a static `form` (unchanged from the original design).
 *   2. `entry.gate` — a static `choice`/`multiSelect`/`redirect`, author-time
 *      fixed content (absorbs the former `StepUIHints`/`GateUIHint` surface).
 *   3. `entry.gateFromOutput` — a DYNAMIC gate: the block is whatever the
 *      workflow's own tool computed and emitted as a step's output (a choice
 *      built from fetched notes, a `reviewList` over generated rows, or a
 *      `gateFallbackBlock`-shaped `error`/`text`/`link` for the empty/
 *      unavailable/failed case) — see `dynamicGateBlock`.
 * An entry with none of these, or a `gateFromOutput` whose source isn't a
 * usable block yet, renders the generic run-page-redirect fallback — NEVER a
 * single-button `choice` that would resolve the gate with an empty payload.
 */
import {
  humanizeStepId,
  type StepUI,
  type StepUIEntry,
  type StepUIGate,
  type StepUIGateOption,
  type StepUIInputField,
} from "@workbench/shared";
import { pendingGateForRun } from "./conversation-gates";
import { runPageRedirectBlock } from "./gate-fallback";
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

function toGateOption(option: StepUIGateOption): {
  id: string;
  label: string;
  value?: string;
  description?: string;
} {
  return {
    id: option.id,
    label: option.label,
    ...(option.value !== undefined ? { value: option.value } : {}),
    ...(option.description !== undefined
      ? { description: option.description }
      : {}),
  };
}

/** Renders a static (author-time) `gate` declaration — the `choice` /
 * `multiSelect` / `redirect` gate kinds `StepUIHints`' `GateUIHint` used to
 * carry, now expressed as plain data instead of a hint object. */
function staticGateBlock(
  gate: StepUIGate,
  signalName: string,
  entry: StepUIEntry,
  run: StepUIRunInput,
): UIBlock {
  const prompt = entry.prompt ?? entry.title;
  if (gate.kind === "redirect") {
    return runPageRedirectBlock(
      run.runId,
      gate.title,
      gate.description,
      run.surface,
    );
  }
  if (gate.kind === "choice") {
    return {
      kind: "choice",
      ...(prompt !== undefined ? { prompt } : {}),
      signalName,
      options: gate.options.map(toGateOption),
    };
  }
  return {
    kind: "multiSelect",
    ...(prompt !== undefined ? { prompt } : {}),
    signalName,
    ...(gate.submitLabel !== undefined
      ? { submitLabel: gate.submitLabel }
      : {}),
    ...(gate.min !== undefined ? { min: gate.min } : {}),
    ...(gate.max !== undefined ? { max: gate.max } : {}),
    options: gate.options.map(toGateOption),
  };
}

const GATE_CAPABLE_KINDS = new Set<UIBlock["kind"]>([
  "form",
  "choice",
  "multiSelect",
  "reviewList",
]);

/** Stamps the run's live `signalName` onto a workflow-emitted gate block
 * (`choice`/`form`/`multiSelect`/`reviewList`) — the tool that computed it
 * doesn't need to know or guess the signal name. A block of any OTHER kind
 * (`error`/`text`/`link`) is one the workflow's own tool already produced via
 * `gateFallbackBlock`/`runPageRedirectBlock` for the empty/unavailable/failed
 * case — it needs no `signalName` and passes through unchanged. */
function stampGateSignalName(block: UIBlock, signalName: string): UIBlock {
  if (!GATE_CAPABLE_KINDS.has(block.kind)) return block;
  return { ...block, signalName } as UIBlock;
}

/**
 * Resolves a dynamic (`entry.gateFromOutput`) gate: the decoded output of
 * `entry.gateSourceStep` (defaulting to the gating step's own id) IS the gate
 * block, computed by the workflow's own tool code — a `choice` built from
 * fetched notes, a `reviewList` over generated rows, or a fallback-shaped
 * `error`/`text`/`link` for the empty/unavailable/failed case. Returns
 * `undefined` when the source output isn't a usable block yet (e.g. the
 * producing step hasn't completed), so the caller can fall back to the
 * generic redirect rather than render nothing.
 */
function dynamicGateBlock(
  entry: StepUIEntry,
  gatingStepId: string,
  signalName: string,
  run: StepUIRunInput,
): UIBlock | undefined {
  const sourceStepId = entry.gateSourceStep ?? gatingStepId;
  const output = run.stepOutputs?.[sourceStepId];
  if (!isUIBlock(output)) return undefined;
  return stampGateSignalName(output, signalName);
}

/**
 * An unrecognized or not-yet-resolvable gate must NEVER offer an action that
 * silently satisfies the `awaitSignal` with an empty payload — that advances
 * a run past a gate that was waiting for real input. Match the hand-written
 * builders' behaviour: redirect to the run page instead.
 */
function genericGateFallback(run: StepUIRunInput): UIBlock {
  return runPageRedirectBlock(
    run.runId,
    "Continue on the run page",
    "This run needs input the dock cannot collect yet. Continue on the run page.",
    run.surface,
  );
}

function gateBlockForEntry(
  entry: StepUIEntry | undefined,
  gatingStepId: string,
  signalName: string,
  run: StepUIRunInput,
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
  if (entry?.gate !== undefined) {
    return staticGateBlock(entry.gate, signalName, entry, run);
  }
  if (entry?.gateFromOutput === true) {
    const resolved = dynamicGateBlock(entry, gatingStepId, signalName, run);
    if (resolved !== undefined) return resolved;
  }
  return genericGateFallback(run);
}

/**
 * Derives a run's dock `UIBlock[]` from its `STEP_UI` map: progress (titles
 * from `STEP_UI`, falling back to a humanized step id), the pending gate
 * (static `form`/`gate` content, a dynamic workflow-emitted block, or the
 * run-page-redirect fallback — see `gateBlockForEntry`), completed steps'
 * declared `output` blocks, then the terminal error/link block — the exact
 * shape `dockRunBlocks` already produces, just driven by a richer per-step map.
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
    blocks.push(
      gateBlockForEntry(
        entry,
        gatingStep?.stepId ?? gate.signalName,
        gate.signalName,
        run,
      ),
    );
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
