/**
 * The pain-point-collateral workflow's own dock blocks (CL-2775).
 *
 * Migrates four of the five HITL gates off the bespoke `ui.tsx` panel and onto
 * the shared UIBlock surface, following the gamma / last30days pattern: this
 * builder derives the run's dock content — a progress block and, at each pending
 * gate, the interactive block that collects its input — from the run's
 * log-derived state plus its decoded step outputs. The `ui.tsx` panel stays as
 * the run-page strangler fallback.
 *
 * Gate → block:
 *   note-selection       → choice   (one option per Granola note; payload {noteId})
 *   context              → form     (single optional `context` textarea)
 *   pain-point-selection → form     (single `selectedIds` multiSelect, max 3)
 *   format-selection     → run-page LINK (the (pain point × format) cartesian
 *                          product join cannot be expressed as a form; the panel
 *                          owns it — mirrors reddit/gamma's run-page fallback)
 *   review               → reviewList (approve/reject each generated piece;
 *                          approvedKey "approvedPieces", each row's FULL
 *                          {format,title,content} payload forwarded downstream)
 *
 * Every emitted payload is validated at the /resume boundary by the matching
 * schema in @workbench/shared (see resume-payload-registry) — the panel POSTs the
 * identical shapes, so a block-driven run and a panel-driven run are interchangeable.
 */
import {
  gateFallbackBlock,
  pendingGateForRun,
  progressStateForStepPhase,
  runPageRedirectBlock,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import {
  parseAnalyze,
  parseGeneratedPieces,
  parseNoteList,
  type GeneratedPiece,
  type GranolaNote,
  type PainPoint,
} from "./parse";

export const NOTE_SELECTION_SIGNAL = "note-selection";
export const CONTEXT_SIGNAL = "context";
export const PAIN_POINT_SELECTION_SIGNAL = "pain-point-selection";
export const FORMAT_SELECTION_SIGNAL = "format-selection";
export const REVIEW_SIGNAL = "review";

/** Cap on approved pain points — mirrors the panel's MAX_PAIN_POINTS. */
export const MAX_PAIN_POINTS = 3;

export interface PainPointCollateralBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces. */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function noteChoice(signalName: string, notes: GranolaNote[]): UIBlock {
  return {
    kind: "choice",
    prompt:
      "Pick the customer call to mine — Myra extracts pain points, customer language, and proof points from the transcript.",
    signalName,
    options: notes.map((note) => ({
      id: note.id,
      label: note.title ?? "Untitled note",
      value: note.id,
      ...(note.summary !== undefined ? { description: note.summary } : {}),
      payload: { noteId: note.id },
    })),
  };
}

function contextForm(signalName: string): UIBlock {
  const context: FormField = {
    kind: "textarea",
    name: "context",
    label: "Add any specific notes or context (optional)",
    placeholder:
      "e.g. focus on integration issues, prospect is a Series B startup…",
  };
  return {
    kind: "form",
    prompt: "Add context to sharpen the pain-point analysis, or continue.",
    signalName,
    submitLabel: "Continue",
    fields: [context],
  };
}

function painPointForm(signalName: string, painPoints: PainPoint[]): UIBlock {
  const field: FormField = {
    kind: "multiSelect",
    name: "selectedIds",
    label: `Select up to ${MAX_PAIN_POINTS} pain points to address`,
    required: true,
    min: 1,
    max: MAX_PAIN_POINTS,
    options: painPoints.map((pp) => ({
      value: pp.id,
      label: pp.title,
      description: pp.detail,
    })),
  };
  return {
    kind: "form",
    prompt: `Choose the pain points to turn into collateral (up to ${MAX_PAIN_POINTS}).`,
    signalName,
    submitLabel: "Select pain points",
    fields: [field],
  };
}

function reviewList(signalName: string, pieces: GeneratedPiece[]): UIBlock {
  return {
    kind: "reviewList",
    title: "Review generated collateral",
    prompt: "Approve the pieces to save to your workbench; reject the rest.",
    signalName,
    approvedKey: "approvedPieces",
    displayFields: [
      { key: "format", label: "Format", kind: "badge" },
      { key: "title", label: "Title" },
      { key: "content", label: "Content", kind: "markdown" },
    ],
    // The row's payload is the FULL piece — {format,title,content} — NOT the
    // display subset. The persist map's argMap reads title/format/content off it,
    // so a display-only payload would create empty artifacts (CL-2775).
    rows: pieces.map((piece, index) => ({
      id: `${piece.format}-${index}`,
      fields: {
        format: piece.format,
        title: piece.title,
        content: piece.content,
      },
      payload: {
        format: piece.format,
        title: piece.title,
        content: piece.content,
      },
    })),
  };
}

export function buildPainPointCollateralBlocks(
  input: PainPointCollateralBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    blocks.push(...gateBlocks(gate.signalName, input));
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

function gateBlocks(
  signalName: string,
  input: PainPointCollateralBlockInput,
): UIBlock[] {
  if (signalName === NOTE_SELECTION_SIGNAL) {
    const notes = parseNoteList(input.stepOutputs.intake);
    if (notes.status === "ok" && notes.value.length > 0) {
      return [noteChoice(signalName, notes.value)];
    }
    return [
      gateFallbackBlock({
        runId: input.runId,
        producingStepId: "intake",
        steps: input.steps,
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
        dataStatus: notes.status === "ok" ? "empty" : "unavailable",
        emptyMessage: "No Granola notes were found for this call.",
        unavailableTitle: "Open the run to pick a transcript",
        unavailableDescription:
          "Your Granola notes aren't available here yet — pick a transcript on the run page.",
      }),
    ];
  }

  if (signalName === CONTEXT_SIGNAL) {
    return [contextForm(signalName)];
  }

  if (signalName === PAIN_POINT_SELECTION_SIGNAL) {
    const painPoints = parseAnalyze(input.stepOutputs.analyze);
    if (painPoints.status === "ok" && painPoints.value.length > 0) {
      return [painPointForm(signalName, painPoints.value)];
    }
    return [
      gateFallbackBlock({
        runId: input.runId,
        producingStepId: "analyze",
        steps: input.steps,
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
        dataStatus: painPoints.status === "ok" ? "empty" : "unavailable",
        emptyMessage: "No pain points were extracted from this call.",
        unavailableTitle: "Open the run to select pain points",
        unavailableDescription:
          "The extracted pain points aren't available here — review and select them on the run page.",
      }),
    ];
  }

  if (signalName === FORMAT_SELECTION_SIGNAL) {
    // The panel pre-computes the (pain point × format) cartesian product and
    // posts one generation item per pair — a join the dock's form/multiSelect
    // primitives can't express. Send the user to the run page rather than POST a
    // shape the dock can't build (CL-2775) — unless the run page IS the
    // surface asking, in which case there's nowhere else to send it (CL-4284).
    return [
      runPageRedirectBlock(
        input.runId,
        "Choose collateral formats on the run page",
        "Pick which formats to generate for each pain point on the run page.",
        input.surface,
      ),
    ];
  }

  if (signalName === REVIEW_SIGNAL) {
    const pieces = parseGeneratedPieces(input.stepOutputs.generate);
    if (pieces.status === "ok" && pieces.value.length > 0) {
      return [reviewList(signalName, pieces.value)];
    }
    return [
      gateFallbackBlock({
        runId: input.runId,
        producingStepId: "generate",
        steps: input.steps,
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
        dataStatus: pieces.status === "ok" ? "empty" : "unavailable",
        emptyMessage: "No collateral was generated to review.",
        unavailableTitle: "Open the run to review collateral",
        unavailableDescription:
          "The generated collateral isn't available here — review and approve it on the run page.",
      }),
    ];
  }

  // Any unknown gate needs input the dock can't collect — send the user to the
  // run page rather than POST an empty payload and corrupt the run.
  return [
    runPageRedirectBlock(
      input.runId,
      "Continue on the run page",
      "This run needs input the dock can't collect yet — continue on the run page.",
      input.surface,
    ),
  ];
}
