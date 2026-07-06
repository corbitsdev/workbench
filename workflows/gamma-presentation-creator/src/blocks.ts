/**
 * The gamma-presentation-creator workflow's own dock blocks (CL-2730).
 *
 * Migrates the per-round HITL preview gate off the bespoke `ui.tsx` panel and
 * onto the shared UIBlock surface, following the ab-compare-hitl pattern: this
 * builder derives the run's dock content — a progress block, the generated
 * draft's slide content rendered as markdown, a link to the live Gamma deck, and
 * an approve/refine choice at the pending `preview-N` gate — from the run's
 * log-derived state plus its decoded step outputs. Un-migrated gates (the
 * multi-field `intake` form, which has no block representation yet — CL-2715)
 * fall back to a run-page link rather than an actionable choice with nothing to
 * collect. The `ui.tsx` panel stays as the fallback for the run page.
 *
 * The refine note the run-page panel collects on a draft is captured here via
 * the choice's prompt-box and folded onto the resume payload under `feedback`,
 * so the dock and the panel deliver equivalent decisions to the `check-N` gate.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import { type } from "arktype";
import { MAX_ROUNDS } from "./constants";

/** The intake gate's `awaitSignal` name (matches the workflow def). */
export const INTAKE_SIGNAL = "intake";

/** A pending preview gate's signal name is `preview-<round>` (see index.ts). */
const PREVIEW_SIGNAL = /^preview-(\d+)$/u;

export interface GammaBlockInput extends DockRunInput {
  /**
   * Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces
   * (the value is the step's output, NOT wrapped in `{ output }`).
   */
  stepOutputs: Record<string, unknown>;
}

// The inline-inference generate step's output carries the slide content on
// `reply` (the render step's argMap reads `{ from: "reply" }`).
const GenerateOutput = type({ reply: "string" });

// The Gamma render tool's output carries the live deck URL — `gammaUrl`, or
// `url` on older tool shapes (mirrors the panel's GammaResult parse).
const RenderOutput = type({ "gammaUrl?": "string", "url?": "string" });

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

function slideContent(
  stepOutputs: Record<string, unknown>,
  round: number,
): string | undefined {
  const parsed = GenerateOutput(stepOutputs[`generate-${round}`]);
  if (parsed instanceof type.errors) return undefined;
  const reply = parsed.reply.trim();
  return reply.length > 0 ? reply : undefined;
}

function deckUrl(
  stepOutputs: Record<string, unknown>,
  round: number,
): string | undefined {
  const parsed = RenderOutput(stepOutputs[`render-${round}`]);
  if (parsed instanceof type.errors) return undefined;
  const candidate = parsed.gammaUrl ?? parsed.url;
  if (candidate === undefined) return undefined;
  try {
    if (new URL(candidate).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

// The pre-fold decision an option carries. The reviewer's refine note is folded
// onto it under `feedback` by the choice's prompt-box at submit time (CL-2683),
// which is where a refine's mandatory `feedback` comes from — so the option's
// build-time payload is intentionally looser than the tightened resume-boundary
// `GammaPreviewPayloadSchema` (which requires `feedback` on a refine).
type PreviewDecision = { approved: boolean };

// Approve and refine are emitted as SEPARATE choice blocks (CL-2730) — mirroring
// the run-page panel, where "approve" is a free primary button and "refine" is a
// note-gated secondary action. Sharing one choice would force the required note
// onto approve too; splitting keeps approve free while the refine box is required.
function previewChoices(
  signalName: string,
  round: number,
  isLast: boolean,
): UIBlock[] {
  const approve: UIBlock = {
    kind: "choice",
    prompt: isLast
      ? `Draft ${round} of up to ${MAX_ROUNDS} — the final draft. Approve to save it.`
      : `Draft ${round} of up to ${MAX_ROUNDS}. Approve it, or refine with notes for the next draft.`,
    signalName,
    options: [
      {
        id: "approve",
        label: "Looks good — approve",
        value: "approve",
        payload: { approved: true } satisfies PreviewDecision,
      },
    ],
  };
  if (isLast) return [approve];
  // The refine box is REQUIRED: an empty-note refine is held (CL-2730), matching
  // the panel's `feedback.trim().length > 0` guard, so the next `generate-N` step
  // never re-rolls blind. The note is folded onto the payload under `feedback`.
  const refine: UIBlock = {
    kind: "choice",
    signalName,
    promptBox: {
      placeholder: "What should change? The next draft revises from this.",
      payloadKey: "feedback",
      required: true,
    },
    options: [
      {
        id: "refine",
        label: "Refine with notes",
        value: "refine",
        payload: { approved: false } satisfies PreviewDecision,
      },
    ],
  };
  return [approve, refine];
}

export function buildGammaBlocks(input: GammaBlockInput): UIBlock[] {
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
    const match = PREVIEW_SIGNAL.exec(gate.signalName);
    if (match !== null && match[1] !== undefined) {
      const round = Number(match[1]);
      const content = slideContent(input.stepOutputs, round);
      if (content !== undefined) {
        // The generated draft, markdown-rendered in full — never truncated.
        blocks.push({
          kind: "document",
          title: `Draft ${round} of up to ${MAX_ROUNDS}`,
          source: content,
        });
        const url = deckUrl(input.stepOutputs, round);
        if (url !== undefined) {
          blocks.push({
            kind: "link",
            url,
            title: "Open in Gamma",
            description: "Preview the rendered deck in Gamma",
          });
        }
        blocks.push(
          ...previewChoices(gate.signalName, round, round >= MAX_ROUNDS),
        );
      } else {
        // The draft content is not resolvable in the dock (stored out of line,
        // or not yet available). Do NOT invite an approve/refine decision with
        // nothing to review — send the user to the run page instead.
        blocks.push(
          runPageLink(
            input.runId,
            "Open the run to review the draft",
            "The generated draft isn't available here — review and decide on the run page.",
          ),
        );
      }
    } else if (gate.signalName === INTAKE_SIGNAL) {
      // The intake gate needs the deck's Gamma TEMPLATE and (optionally) a source
      // artifact / Granola note — all opaque ids the user cannot obtain in the
      // dock. Only the run page can query the template catalogue and the source
      // pickers, so the dock is a visibility surface here: it shows progress and
      // links to the run page to launch the deck, rather than demanding ids in a
      // form (CL-2684).
      blocks.push(
        runPageLink(
          input.runId,
          "Set up the deck on the run page",
          "Pick the Gamma template and the source to build from on the run page.",
        ),
      );
    } else {
      // Any other gate needs input the dock can't collect — send the user to the
      // run page rather than POST an empty payload and corrupt the run.
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
