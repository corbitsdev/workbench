import { describe, expect, test } from "bun:test";
import { classifyRunError } from "@workbench/ui";
import {
  gateFallbackBlock,
  runPageLink,
  runPageRedirectBlock,
} from "./gate-fallback";
import type { DockRunStep } from "./run-dock-blocks";

describe("gateFallbackBlock (CL-4284)", () => {
  test("the producing step FAILED: an error block naming it, with a CLASSIFIED detail — never a run-page link", () => {
    const steps: DockRunStep[] = [
      {
        stepId: "intake",
        phase: "failed",
        lastError: { message: "Granola API error: 502 Bad Gateway" },
      },
      { stepId: "note-selection", phase: "awaiting-signal" },
    ];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      dataStatus: "unavailable",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here.",
    });
    expect(block.kind).toBe("error");
    if (block.kind !== "error") throw new Error("expected an error block");
    expect(block.message).toContain("Intake");
    expect(block.detail).toBe(
      classifyRunError("Granola API error: 502 Bad Gateway").userMessage,
    );
    expect(block.detail).toBe(
      "Granola had a problem on its end (502). Try running this again shortly.",
    );
  });

  test("a raw internal-looking error (session id, hostname) never reaches detail", () => {
    const steps: DockRunStep[] = [
      {
        stepId: "intake",
        phase: "failed",
        lastError: {
          message:
            "Error at ses_9f21ab on internal-worker-3.corbits.internal: constraint violation",
        },
      },
      { stepId: "note-selection", phase: "awaiting-signal" },
    ];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      dataStatus: "unavailable",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here.",
    });
    expect(block.kind).toBe("error");
    if (block.kind !== "error") throw new Error("expected an error block");
    expect(block.detail).not.toContain("ses_9f21ab");
    expect(block.detail).not.toContain("internal-worker-3.corbits.internal");
    expect(block.detail).toBe(
      "Something went wrong inside this workflow run. Try running it again; if it keeps failing, contact your workspace admin.",
    );
  });

  test("the producing step FAILED wins even when the caller's dataStatus says empty", () => {
    // A failed step never has real data — `dataStatus` reflects a parse the
    // caller ran on absent output, so `failed` must take priority regardless.
    const steps: DockRunStep[] = [{ stepId: "intake", phase: "failed" }];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      dataStatus: "empty",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here.",
    });
    expect(block.kind).toBe("error");
  });

  test("succeeded but produced nothing: an honest empty state, not an error or link", () => {
    const steps: DockRunStep[] = [
      { stepId: "intake", phase: "completed" },
      { stepId: "note-selection", phase: "awaiting-signal" },
    ];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      dataStatus: "empty",
      emptyMessage: "No Granola notes were found for this call.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here.",
    });
    expect(block.kind).toBe("text");
    if (block.kind !== "text") throw new Error("expected a text block");
    expect(block.text).toBe("No Granola notes were found for this call.");
  });

  test("output not available on this surface: the run-page link, on the dock", () => {
    const steps: DockRunStep[] = [
      { stepId: "intake", phase: "in-flight" },
      { stepId: "note-selection", phase: "awaiting-signal" },
    ];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      surface: "dock",
      dataStatus: "unavailable",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here yet.",
    });
    expect(block.kind).toBe("link");
    if (block.kind !== "link") throw new Error("expected a link block");
    expect(block.url).toBe("/workflows/run_1");
    expect(block.title).toBe("Open the run to pick a transcript");
  });

  test("output not available on this surface: no self-link when already on the run page", () => {
    const steps: DockRunStep[] = [
      { stepId: "intake", phase: "in-flight" },
      { stepId: "note-selection", phase: "awaiting-signal" },
    ];
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps,
      surface: "run-page",
      dataStatus: "unavailable",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run to pick a transcript",
      unavailableDescription: "Your notes aren't available here yet.",
    });
    expect(block.kind).not.toBe("link");
    expect(block.kind).toBe("text");
    if (block.kind !== "text") throw new Error("expected a text block");
    expect(block.text).toBe("Your notes aren't available here yet.");
  });

  test("undefined surface (legacy caller) defaults to the dock's link behavior", () => {
    const block = gateFallbackBlock({
      runId: "run_1",
      producingStepId: "intake",
      steps: [],
      dataStatus: "unavailable",
      emptyMessage: "No notes found.",
      unavailableTitle: "Open the run",
      unavailableDescription: "Not available here.",
    });
    expect(block.kind).toBe("link");
  });
});

describe("runPageRedirectBlock (CL-4284)", () => {
  test("renders a link when the surface isn't the run page", () => {
    const block = runPageRedirectBlock(
      "run_2",
      "Continue on the run page",
      "Finish there.",
      "dock",
    );
    expect(block).toEqual(
      runPageLink("run_2", "Continue on the run page", "Finish there."),
    );
  });

  test("degrades to plain text — never a self-link — when already on the run page", () => {
    const block = runPageRedirectBlock(
      "run_2",
      "Continue on the run page",
      "Finish there.",
      "run-page",
    );
    expect(block).toEqual({ kind: "text", text: "Finish there." });
  });
});
