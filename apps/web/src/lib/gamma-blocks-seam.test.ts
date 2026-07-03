import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildGammaBlocks } from "@workbench/workflow-gamma-presentation-creator/blocks";
import {
  logRunStateSchema,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
} from "./run-state-adapter";

// Drives a real log-derived run state through the production
// `stepOutputsFromLog` + `runStateFromLog` decoders — exactly what WorkflowDock
// does — and only THEN into the block builder, so the test starts from
// wire-shaped data (inline outputRefs), not a pre-trusted object (CL-2730,
// mirrors the ab-compare-hitl seam test).

function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

const inline = (value: unknown): string => `inline:${JSON.stringify(value)}`;

function toSteps(log: LogRunState) {
  return log.steps.map((step) => ({
    stepId: step.stepId,
    phase: step.phase,
    ...(step.awaitingSignalName !== undefined
      ? { awaitingSignalName: step.awaitingSignalName }
      : {}),
  }));
}

const SLIDES = "SLIDE 1: The tension\nThe deal stalls at security review.";

describe("gamma-presentation-creator blocks — real log→state→blocks seam", () => {
  const rawPreviewLog = {
    runId: "run_gamma",
    phase: "running" as const,
    lastSeq: 9,
    steps: [
      {
        stepId: "intake",
        phase: "completed" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        outputRef: inline({
          deckTitle: "Security review deck",
          gammaId: "tmpl_1",
          artifactId: "art_1",
        }),
      },
      {
        stepId: "generate-1",
        phase: "completed" as const,
        stepType: "inline" as const,
        currentAttempt: 1,
        outputRef: inline({ reply: SLIDES }),
      },
      {
        stepId: "render-1",
        phase: "completed" as const,
        stepType: "deterministic" as const,
        currentAttempt: 1,
        outputRef: inline({
          gammaUrl: "https://gamma.app/docs/abc123",
          gammaId: "g_abc123",
        }),
      },
      {
        stepId: "describe-1",
        phase: "completed" as const,
        stepType: "inline" as const,
        currentAttempt: 1,
        outputRef: inline({ reply: "A deck on clearing security review." }),
      },
      {
        stepId: "preview-1",
        phase: "awaiting-signal" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        awaitingSignalName: "preview-1",
      },
    ],
  };

  it("renders the drafted slides, a Gamma link, and an approve/refine choice", () => {
    const log = parseLog(rawPreviewLog);

    // The production decoders — the seam under test.
    const stepOutputs = stepOutputsFromLog(log);
    const state = runStateFromLog(log);

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: state.phase,
      steps: toSteps(log),
      stepOutputs,
    });

    // The draft slide content is markdown-rendered in full — not truncated.
    const doc = blocks.find((b) => b.kind === "document");
    expect(doc?.kind === "document" && doc.source).toBe(SLIDES);

    // A run parked on the preview gate gets a link to the live Gamma deck.
    const link = blocks.find(
      (b) => b.kind === "link" && b.url === "https://gamma.app/docs/abc123",
    );
    expect(link).toBeDefined();

    // Approve and refine are SEPARATE choices (CL-2730): approve is free, the
    // refine box is required so a guidance-less refine cannot be submitted.
    const choices = blocks.filter((b) => b.kind === "choice");
    const approveChoice = choices.find((c) =>
      c.kind === "choice" ? c.options.some((o) => o.id === "approve") : false,
    );
    const refineChoice = choices.find((c) =>
      c.kind === "choice" ? c.options.some((o) => o.id === "refine") : false,
    );

    expect(approveChoice?.kind).toBe("choice");
    if (approveChoice?.kind === "choice") {
      expect(approveChoice.signalName).toBe("preview-1");
      expect(approveChoice.promptBox).toBeUndefined();
      const approve = approveChoice.options.find((o) => o.id === "approve");
      expect(approve?.payload).toEqual({ approved: true });
    }

    expect(refineChoice?.kind).toBe("choice");
    if (refineChoice?.kind === "choice") {
      expect(refineChoice.signalName).toBe("preview-1");
      expect(refineChoice.promptBox?.payloadKey).toBe("feedback");
      expect(refineChoice.promptBox?.required).toBe(true);
      const refine = refineChoice.options.find((o) => o.id === "refine");
      expect(refine?.payload).toEqual({ approved: false });
    }
  });

  it("offers approve-only with no refine box on the final round", () => {
    const log = parseLog({
      ...rawPreviewLog,
      steps: rawPreviewLog.steps.map((step) => {
        if (step.stepId === "generate-1")
          return { ...step, stepId: "generate-3" };
        if (step.stepId === "render-1") return { ...step, stepId: "render-3" };
        if (step.stepId === "preview-1")
          return {
            ...step,
            stepId: "preview-3",
            awaitingSignalName: "preview-3",
          };
        return step;
      }),
    });

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
      stepOutputs: stepOutputsFromLog(log),
    });

    const choice = blocks.find((b) => b.kind === "choice");
    expect(choice?.kind).toBe("choice");
    if (choice?.kind === "choice") {
      expect(choice.signalName).toBe("preview-3");
      expect(choice.options.map((o) => o.id)).toEqual(["approve"]);
      expect(choice.promptBox).toBeUndefined();
    }
  });

  it("sends the intake form gate to the run page, not an empty choice", () => {
    const log = parseLog({
      runId: "run_intake",
      phase: "running" as const,
      lastSeq: 2,
      steps: [
        {
          stepId: "list-artifacts",
          phase: "completed" as const,
          stepType: "deterministic" as const,
          currentAttempt: 1,
          outputRef: inline({ artifacts: [] }),
        },
        {
          stepId: "intake",
          phase: "awaiting-signal" as const,
          stepType: "human" as const,
          currentAttempt: 1,
          awaitingSignalName: "intake",
        },
      ],
    });

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
      stepOutputs: stepOutputsFromLog(log),
    });

    // A multi-field form the dock can't collect → run-page link, no choice.
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/workflows/run_intake");
  });

  it("omits an out-of-line (blob) draft, so no actionable decision renders", () => {
    const log = parseLog({
      ...rawPreviewLog,
      steps: rawPreviewLog.steps.map((step) =>
        step.stepId === "generate-1"
          ? { ...step, outputRef: "blob:sha256-abc123" }
          : step,
      ),
    });

    const stepOutputs = stepOutputsFromLog(log);
    // The blob ref is not client-resolvable — the draft content is absent.
    expect(stepOutputs["generate-1"]).toBeUndefined();

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
      stepOutputs,
    });

    // Nothing to review → no approve/refine choice, a run-page link instead.
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });
});
