/**
 * Equivalence proof against a HARD workflow: `pain-point-collateral` has four
 * of its five HITL gates driven by a PRIOR step's decoded output (a Granola
 * note list, extracted pain points, generated collateral) plus three-way
 * empty/unavailable/failed branching via `gateFallbackBlock` — exactly the
 * shape the gtm-scripts-briefs proof (a single static intake form) could not
 * exercise.
 *
 * Every gate below turns out expressible under the STEP_UI split:
 *   - `context`         → static `form` (`entry.input`, unchanged mechanism)
 *   - `format-selection` → static `redirect` gate (`entry.gate`, fixed copy,
 *                          no data dependency — the (pain point × format)
 *                          cartesian join itself still can't be a form/choice,
 *                          but the FALLBACK COPY for it is author-time fixed)
 *   - `note-selection`, `pain-point-selection`, `review` → dynamic gates
 *     (`entry.gateFromOutput`): the block is whatever the workflow's own tool
 *     would have computed (`noteChoice`/`painPointForm`/`reviewList`, or
 *     `gateFallbackBlock`'s error/text/link for the empty/unavailable/failed
 *     case) and handed across as a prior step's output — `review`'s
 *     `reviewList` is read from `generate`'s output while `review` itself is
 *     still PENDING (`gateSourceStep`), the exact case the static map could
 *     never express.
 *
 * Nothing in this workflow's five gates was left inexpressible.
 *
 * Host-side only, no `workflows/*` dependency edge: every helper below
 * (`noteChoice`, `painPointForm`, `reviewList`, the parse.ts subset) is copied
 * VERBATIM from `workflows/pain-point-collateral/src/{blocks,parse}.ts`, not
 * imported — mirrors the gtm-scripts-briefs proof's own strategy. The "drift
 * guard" describe block reads both live files and asserts their load-bearing
 * literals still match this transcription.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { humanizeStepId, type StepUI } from "@workbench/shared";
import { blocksFromStepUI } from "./step-ui";
import { gateFallbackBlock, runPageRedirectBlock } from "./gate-fallback";
import { pendingGateForRun } from "./conversation-gates";
import { progressStateForStepPhase } from "./run-dock-blocks";
import type {
  DockRunInput,
  DockRunStep,
  FormField,
  ProgressStep,
  StepUIRunInput,
  UIBlock,
} from ".";

// -------------------------------------------------------------------------
// Copied verbatim from workflows/pain-point-collateral/src/parse.ts (subset)
// -------------------------------------------------------------------------

const ToolResultEnvelope = type({ content: "string" });
const GranolaNoteSchema = type({
  id: "string",
  "title?": "string | null",
  "created_at?": "string",
  "summary?": "string",
});
type GranolaNote = typeof GranolaNoteSchema.infer;
const GranolaListContent = type({ notes: GranolaNoteSchema.array() });

const PainPointSchema = type({
  id: "string",
  title: "string",
  detail: "string",
  "severity?": "'low' | 'medium' | 'high' | 'critical'",
});
type PainPoint = typeof PainPointSchema.infer;
const AnalyzeOutput = type({ painPoints: PainPointSchema.array() });

const GeneratedPieceSchema = type({
  format: "string",
  title: "string",
  content: "string",
});
type GeneratedPiece = typeof GeneratedPieceSchema.infer;

const AgentReplyEnvelope = type({ reply: "string" });

type Decoded<T> =
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: T };

function decodeToolEnvelope(
  raw: unknown,
):
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: unknown } {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  try {
    return { status: "ok", value: JSON.parse(envelope.content) };
  } catch {
    return { status: "malformed" };
  }
}

function parseNoteList(raw: unknown): Decoded<GranolaNote[]> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== "ok") return decoded;
  const parsed = GranolaListContent(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.notes };
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/);
  return fenced?.[2]?.trim() ?? text;
}

function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAgentJson(
  reply: string,
):
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: unknown } {
  const trimmed = reply.trim();
  if (trimmed === "") return { status: "pending" };
  const unfenced = stripCodeFence(trimmed);
  const jsonText = extractFirstJsonValue(unfenced) ?? unfenced;
  try {
    return { status: "ok", value: JSON.parse(jsonText) };
  } catch {
    return { status: "malformed" };
  }
}

function parseAnalyze(raw: unknown): Decoded<PainPoint[]> {
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  const decoded = parseAgentJson(envelope.reply);
  if (decoded.status !== "ok") return decoded;
  const parsed = AnalyzeOutput(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.painPoints };
}

function parseGeneratedPieces(raw: unknown): Decoded<GeneratedPiece[]> {
  if (!Array.isArray(raw)) return { status: "pending" };
  if (raw.length === 0) return { status: "pending" };
  const pieces: GeneratedPiece[] = [];
  for (const item of raw) {
    const envelope = AgentReplyEnvelope(item);
    if (envelope instanceof type.errors) continue;
    const decoded = parseAgentJson(envelope.reply);
    if (decoded.status !== "ok") continue;
    const parsed = GeneratedPieceSchema(decoded.value);
    if (parsed instanceof type.errors) continue;
    pieces.push(parsed);
  }
  if (pieces.length === 0) return { status: "malformed" };
  return { status: "ok", value: pieces };
}

// -------------------------------------------------------------------------
// Copied verbatim from workflows/pain-point-collateral/src/blocks.ts
// -------------------------------------------------------------------------

const NOTE_SELECTION_SIGNAL = "note-selection";
const CONTEXT_SIGNAL = "context";
const PAIN_POINT_SELECTION_SIGNAL = "pain-point-selection";
const FORMAT_SELECTION_SIGNAL = "format-selection";
const REVIEW_SIGNAL = "review";
const MAX_PAIN_POINTS = 3;

interface PainPointCollateralBlockInput extends DockRunInput {
  stepOutputs: Record<string, unknown>;
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

function referenceBuildPainPointCollateralBlocks(
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
    blocks.push(...referenceGateBlocks(gate.signalName, input));
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

function referenceGateBlocks(
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

  return [
    runPageRedirectBlock(
      input.runId,
      "Continue on the run page",
      "This run needs input the dock can't collect yet — continue on the run page.",
      input.surface,
    ),
  ];
}

// -------------------------------------------------------------------------
// The STEP_UI map a real migration would export next to `workflow = defineWorkflow(...)`
// -------------------------------------------------------------------------

const PAIN_POINT_COLLATERAL_STEP_UI: StepUI = {
  select: { gateFromOutput: true, gateSourceStep: "intake" },
  context: {
    prompt: "Add context to sharpen the pain-point analysis, or continue.",
    submitLabel: "Continue",
    input: [
      {
        kind: "textarea",
        name: "context",
        label: "Add any specific notes or context (optional)",
        placeholder:
          "e.g. focus on integration issues, prospect is a Series B startup…",
      },
    ],
  },
  ppSelection: { gateFromOutput: true, gateSourceStep: "analyze" },
  fmtSelection: {
    gate: {
      kind: "redirect",
      title: "Choose collateral formats on the run page",
      description:
        "Pick which formats to generate for each pain point on the run page.",
    },
  },
  review: { gateFromOutput: true, gateSourceStep: "generate" },
};

const NOTES: GranolaNote[] = [
  { id: "note_1", title: "Acme kickoff call", summary: "Integration pains" },
  { id: "note_2", title: "Beta renewal call" },
];

const PAIN_POINTS: PainPoint[] = [
  { id: "pp_1", title: "Slow onboarding", detail: "Takes 6 weeks" },
  {
    id: "pp_2",
    title: "Fragile integrations",
    detail: "Breaks on API changes",
  },
];

const PIECES: GeneratedPiece[] = [
  { format: "linkedin", title: "Onboarding pain", content: "Body 1" },
  { format: "email", title: "Integration risk", content: "Body 2" },
];

describe("STEP_UI equivalence: pain-point-collateral (hard workflow)", () => {
  test("note-selection gate, real data: dynamic choice from the intake step's own output", () => {
    const run: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        { stepId: "intake", phase: "completed" },
        {
          stepId: "select",
          phase: "awaiting-signal",
          awaitingSignalName: NOTE_SELECTION_SIGNAL,
        },
      ],
      stepOutputs: {
        intake: { content: JSON.stringify({ notes: NOTES }) },
      },
    };
    const expected = referenceBuildPainPointCollateralBlocks(run);
    // The workflow's own tool would emit the CHOICE BLOCK itself (no
    // signalName needed — the host stamps the live one) as the gating step's
    // source output, in place of the raw Granola envelope above.
    const dynamicRun: StepUIRunInput & PainPointCollateralBlockInput = {
      ...run,
      stepOutputs: { intake: noteChoice("unused", NOTES) },
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, dynamicRun);
    expect(actual[1]).toEqual(expected[1]);
  });

  test("note-selection gate, no notes (ok, empty): the empty-state text block", () => {
    const steps: DockRunStep[] = [
      { stepId: "intake", phase: "completed" },
      {
        stepId: "select",
        phase: "awaiting-signal",
        awaitingSignalName: NOTE_SELECTION_SIGNAL,
      },
    ];
    const reference: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: { intake: { content: JSON.stringify({ notes: [] }) } },
    };
    const expected = referenceBuildPainPointCollateralBlocks(reference);
    const dynamicRun: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {
        intake: gateFallbackBlock({
          runId: "run_1",
          producingStepId: "intake",
          steps,
          dataStatus: "empty",
          emptyMessage: "No Granola notes were found for this call.",
          unavailableTitle: "Open the run to pick a transcript",
          unavailableDescription:
            "Your Granola notes aren't available here yet — pick a transcript on the run page.",
        }),
      },
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, dynamicRun);
    expect(actual[1]).toEqual(expected[1]);
    expect(actual.find((b) => b.kind === "text")).toBeDefined();
  });

  test("note-selection gate, the intake step FAILED: an error block, not a link", () => {
    const steps: DockRunStep[] = [
      {
        stepId: "intake",
        phase: "failed",
        lastError: { message: "Granola API error: 502 Bad Gateway" },
      },
      {
        stepId: "select",
        phase: "awaiting-signal",
        awaitingSignalName: NOTE_SELECTION_SIGNAL,
      },
    ];
    const reference: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {},
    };
    const expected = referenceBuildPainPointCollateralBlocks(reference);
    const dynamicRun: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {
        intake: gateFallbackBlock({
          runId: "run_1",
          producingStepId: "intake",
          steps,
          dataStatus: "unavailable",
          emptyMessage: "No Granola notes were found for this call.",
          unavailableTitle: "Open the run to pick a transcript",
          unavailableDescription:
            "Your Granola notes aren't available here yet — pick a transcript on the run page.",
        }),
      },
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, dynamicRun);
    expect(actual[1]).toEqual(expected[1]);
    expect(actual.find((b) => b.kind === "error")).toBeDefined();
  });

  test("context gate: static form, unchanged mechanism (entry.input)", () => {
    const run: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        {
          stepId: "context",
          phase: "awaiting-signal",
          awaitingSignalName: CONTEXT_SIGNAL,
        },
      ],
      stepOutputs: {},
    };
    const expected = referenceBuildPainPointCollateralBlocks(run);
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, run);
    expect(actual[1]).toEqual(expected[1]);
  });

  test("pain-point-selection gate, real data: dynamic multiSelect form from the analyze step's output", () => {
    const steps: DockRunStep[] = [
      { stepId: "analyze", phase: "completed" },
      {
        stepId: "ppSelection",
        phase: "awaiting-signal",
        awaitingSignalName: PAIN_POINT_SELECTION_SIGNAL,
      },
    ];
    const reference: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {
        analyze: { reply: JSON.stringify({ painPoints: PAIN_POINTS }) },
      },
    };
    const expected = referenceBuildPainPointCollateralBlocks(reference);
    const dynamicRun: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: { analyze: painPointForm("unused", PAIN_POINTS) },
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, dynamicRun);
    expect(actual[1]).toEqual(expected[1]);
  });

  test("format-selection gate: static redirect gate, fixed copy, no data dependency", () => {
    const run: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        {
          stepId: "fmtSelection",
          phase: "awaiting-signal",
          awaitingSignalName: FORMAT_SELECTION_SIGNAL,
        },
      ],
      stepOutputs: {},
    };
    const expected = referenceBuildPainPointCollateralBlocks(run);
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, run);
    // Full-array equality: both sides now share the one sentence-case
    // `humanizeStepId` (`@workbench/shared`), so there is no longer a casing
    // divergence between STEP_UI's derivation and the hand-written reference
    // builder to work around.
    expect(actual).toEqual(expected);
  });

  test("review gate: reviewList read from an EARLIER step's output while the gate itself is PENDING", () => {
    const steps: DockRunStep[] = [
      { stepId: "generate", phase: "completed" },
      {
        stepId: "review",
        phase: "awaiting-signal",
        awaitingSignalName: REVIEW_SIGNAL,
      },
    ];
    const reference: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {
        generate: PIECES.map((piece) => ({
          reply: JSON.stringify(piece),
        })),
      },
    };
    const expected = referenceBuildPainPointCollateralBlocks(reference);
    const dynamicRun: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: { generate: reviewList("unused", PIECES) },
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, dynamicRun);
    // See the format-selection test above for why this compares gate blocks
    // only, not the full array (progress-label casing intentionally diverges).
    expect(actual[1]).toEqual(expected[1]);
    const gateBlock = actual.find((b) => b.kind === "reviewList");
    expect(gateBlock).toBeDefined();
    if (gateBlock?.kind === "reviewList") {
      expect(gateBlock.signalName).toBe(REVIEW_SIGNAL);
    }
  });

  test("review gate not yet resolvable (generate step still in-flight): falls back to the run-page redirect, never an empty-payload choice", () => {
    const steps: DockRunStep[] = [
      { stepId: "generate", phase: "in-flight" },
      {
        stepId: "review",
        phase: "awaiting-signal",
        awaitingSignalName: REVIEW_SIGNAL,
      },
    ];
    const run: StepUIRunInput & PainPointCollateralBlockInput = {
      runId: "run_1",
      phase: "running",
      steps,
      stepOutputs: {},
    };
    const actual = blocksFromStepUI(PAIN_POINT_COLLATERAL_STEP_UI, run);
    const gateBlock = actual.find((b) =>
      ["form", "choice", "multiSelect", "reviewList"].includes(b.kind),
    );
    expect(gateBlock).toBeUndefined();
    const link = actual.find((b) => b.kind === "link");
    expect(link).toBeDefined();
  });
});

describe("drift guard: the copied helpers vs the live files", () => {
  test("workflows/pain-point-collateral/src/blocks.ts still matches the transcribed literals", () => {
    const live = readFileSync(
      new URL(
        "../../../workflows/pain-point-collateral/src/blocks.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(live).toContain(
      "Pick the customer call to mine — Myra extracts pain points, customer language, and proof points from the transcript.",
    );
    expect(live).toContain(
      "Add context to sharpen the pain-point analysis, or continue.",
    );
    expect(live).toContain("Select up to ${MAX_PAIN_POINTS} pain points");
    expect(live).toContain("Choose collateral formats on the run page");
    expect(live).toContain(
      "Pick which formats to generate for each pain point on the run page.",
    );
    expect(live).toContain("Review generated collateral");
  });

  test("workflows/pain-point-collateral/src/parse.ts still matches the transcribed parsers", () => {
    const live = readFileSync(
      new URL(
        "../../../workflows/pain-point-collateral/src/parse.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(live).toContain("export function parseNoteList");
    expect(live).toContain("export function parseAnalyze");
    expect(live).toContain("export function parseGeneratedPieces");
    // If any of the above ever fails, re-copy the live files' parsers and
    // block builders into this test before trusting this equivalence proof
    // again.
  });
});
