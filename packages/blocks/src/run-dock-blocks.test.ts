import { describe, expect, it } from "bun:test";
import {
  dockRunBlocks,
  progressStateForStepPhase,
  type DockRunInput,
} from "./run-dock-blocks";

function baseRun(overrides: Partial<DockRunInput> = {}): DockRunInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      { stepId: "fetch_sources", phase: "completed" },
      { stepId: "draft", phase: "in-flight" },
      { stepId: "review-gate", phase: "awaiting-signal" },
      { stepId: "publish", phase: "failed" },
    ],
    ...overrides,
  };
}

describe("progressStateForStepPhase", () => {
  it("maps every log step phase onto a ProgressStep state", () => {
    expect(progressStateForStepPhase("in-flight")).toBe("running");
    expect(progressStateForStepPhase("awaiting-signal")).toBe("awaiting");
    expect(progressStateForStepPhase("awaiting-timer")).toBe("awaiting");
    expect(progressStateForStepPhase("completed")).toBe("done");
    expect(progressStateForStepPhase("failed")).toBe("failed");
    expect(progressStateForStepPhase("cancelled")).toBe("failed");
  });
});

describe("dockRunBlocks", () => {
  it("builds a progress block from the run's steps with humanized labels", () => {
    const blocks = dockRunBlocks(baseRun());
    expect(blocks).toHaveLength(1);
    const progress = blocks[0];
    if (progress?.kind !== "progress") throw new Error("expected progress");
    expect(progress.steps).toEqual([
      { state: "done", label: "fetch sources" },
      { state: "running", label: "draft" },
      { state: "awaiting", label: "review gate" },
      { state: "failed", label: "publish" },
    ]);
  });

  it("emits no progress block when the run has no steps yet", () => {
    expect(dockRunBlocks(baseRun({ steps: [] }))).toEqual([]);
  });

  it("appends an error block on a failed run with a sanitized message", () => {
    const blocks = dockRunBlocks(
      baseRun({
        phase: "failed",
        errorMessage: "Exa is rate-limiting requests right now.",
      }),
    );
    const error = blocks.find((b) => b.kind === "error");
    if (error?.kind !== "error") throw new Error("expected error block");
    expect(error.message).toBe("Exa is rate-limiting requests right now.");
  });

  it("emits no error block when the run is failed without a message", () => {
    const blocks = dockRunBlocks(baseRun({ phase: "failed" }));
    expect(blocks.some((b) => b.kind === "error")).toBe(false);
  });

  it("emits no error block when the run is not failed", () => {
    const blocks = dockRunBlocks(
      baseRun({ phase: "running", errorMessage: "should not surface" }),
    );
    expect(blocks.some((b) => b.kind === "error")).toBe(false);
  });

  it("appends a link block on completion when a link is provided", () => {
    const blocks = dockRunBlocks(
      baseRun({
        phase: "completed",
        completedLink: {
          url: "/workflows/run_1",
          title: "View results",
          description: "Outputs and artifacts",
        },
      }),
    );
    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") throw new Error("expected link block");
    expect(link.url).toBe("/workflows/run_1");
    expect(link.title).toBe("View results");
    expect(link.description).toBe("Outputs and artifacts");
  });

  it("emits a gate choice block carrying the recovered signalName", () => {
    const blocks = dockRunBlocks(
      baseRun({
        steps: [
          { stepId: "draft", phase: "completed" },
          {
            stepId: "review-gate",
            phase: "awaiting-signal",
            awaitingSignalName: "review-draft",
          },
        ],
      }),
    );
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected choice block");
    expect(choice.signalName).toBe("review-draft");
    expect(choice.options).toHaveLength(1);
  });

  it("emits no gate block when the awaiting step has no recoverable signalName", () => {
    const blocks = dockRunBlocks(
      baseRun({
        steps: [{ stepId: "review-gate", phase: "awaiting-signal" }],
      }),
    );
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
  });

  it("emits no link block before the run completes", () => {
    const blocks = dockRunBlocks(
      baseRun({
        phase: "running",
        completedLink: { url: "/workflows/run_1", title: "View results" },
      }),
    );
    expect(blocks.some((b) => b.kind === "link")).toBe(false);
  });
});
