import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildGammaBlocks } from "@workbench/workflow-gamma-presentation-creator/blocks";
import { GammaIntakePayloadSchema } from "@workbench/shared";
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
// mirrors the ab-compare-quality seam test).

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

describe("gamma-presentation-creator blocks — real log→state→blocks seam", () => {
  // Single-shot run: intake -> generate -> render -> describe ->
  // persist, no per-round preview/refine gate. Mid-flight the dock shows only
  // progress — the run has nothing more to decide until it either finishes or
  // fails, so no link/choice block is expected here.
  it("renders progress for a run mid-flight with no gate and no completed link", () => {
    const log = parseLog({
      runId: "run_gamma",
      phase: "running" as const,
      lastSeq: 5,
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
          stepId: "generate",
          phase: "completed" as const,
          stepType: "inline" as const,
          currentAttempt: 1,
          outputRef: inline({
            reply: "SLIDE 1: The tension\nThe deal stalls at security review.",
          }),
        },
        {
          stepId: "render",
          phase: "in-flight" as const,
          stepType: "deterministic" as const,
          currentAttempt: 1,
        },
      ],
    });

    const stepOutputs = stepOutputsFromLog(log);
    const state = runStateFromLog(log);

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: state.phase,
      steps: toSteps(log),
      stepOutputs,
    });

    const progress = blocks.find((b) => b.kind === "progress");
    if (progress?.kind !== "progress") {
      throw new Error("expected a progress block");
    }
    expect(progress.steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "running",
    ]);

    // Nothing is awaiting signal and the run isn't complete — no gate link,
    // no completed link, no choice (that mechanism no longer exists).
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
  });

  it("renders the run-page link once the deck is persisted and the run completes", () => {
    const log = parseLog({
      runId: "run_gamma",
      phase: "completed" as const,
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
          stepId: "generate",
          phase: "completed" as const,
          stepType: "inline" as const,
          currentAttempt: 1,
          outputRef: inline({
            reply: "SLIDE 1: The tension\nThe deal stalls at security review.",
          }),
        },
        {
          stepId: "render",
          phase: "completed" as const,
          stepType: "deterministic" as const,
          currentAttempt: 1,
          outputRef: inline({
            gammaUrl: "https://gamma.app/docs/abc123",
            gammaId: "g_abc123",
          }),
        },
        {
          stepId: "describe",
          phase: "completed" as const,
          stepType: "inline" as const,
          currentAttempt: 1,
          outputRef: inline({ reply: "A deck on clearing security review." }),
        },
        {
          stepId: "persist",
          phase: "completed" as const,
          stepType: "deterministic" as const,
          currentAttempt: 1,
          outputRef: inline({ artifactId: "art_deck_1" }),
        },
      ],
    });

    const stepOutputs = stepOutputsFromLog(log);
    const state = runStateFromLog(log);

    const blocks = buildGammaBlocks({
      runId: log.runId,
      phase: state.phase,
      steps: toSteps(log),
      stepOutputs,
      completedLink: {
        url: `/workflows/${log.runId}`,
        title: "View results",
        description: "Outputs and artifacts on the run page",
      },
    });

    // No gate pending once the run is complete — no choice block either
    // (single-shot has no approve/refine mechanism).
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);

    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") {
      throw new Error("expected a completed-run link");
    }
    expect(link.url).toBe(`/workflows/${log.runId}`);
    expect(link.title).toBe("View results");
  });

  it("links to the run page at the intake gate rather than demanding opaque ids in a form (CL-2684)", () => {
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

    // The intake gate needs the Gamma TEMPLATE + source (opaque ids the dock
    // can't resolve), so the dock is a visibility surface: a run-page link, NOT
    // a form demanding those ids.
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") throw new Error("expected a run-page link");
    expect(link.url).toBe("/workflows/run_intake");

    // The run-page panel still submits through the same boundary schema: a
    // well-formed intake validates; a hollow one (no title/template) is rejected.
    const wellFormed = {
      deckTitle: "Security review deck",
      gammaId: "tmpl_1",
      text: "Paste the brief here.",
    };
    expect(GammaIntakePayloadSchema(wellFormed) instanceof type.errors).toBe(
      false,
    );
    const hollow = { deckTitle: "", gammaId: "", text: "" };
    expect(GammaIntakePayloadSchema(hollow) instanceof type.errors).toBe(true);
  });
});
