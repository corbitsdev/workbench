/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  buildRunStepperSteps,
  HorizontalStepper,
  type DisplayStep,
} from "@workbench/ui";
import { runStateFromLog, type LogRunState } from "../lib/run-state-adapter";

// End-to-end proof that the stepper's per-step status is driven by the
// log-derived run state (CL-2669): a LogRunState is folded to the @intx/workflow
// RunState via runStateFromLog, mapped to stepper rows via the shared
// buildRunStepperSteps helper, and rendered by HorizontalStepper. We assert the
// actual rendered indicator (✓ / ! / number) and its status colour, so a
// regression in the mapping fails the render.

function logState(over: Partial<LogRunState>): LogRunState {
  return { runId: "wfr_1", phase: "running", lastSeq: 0, steps: [], ...over };
}

function display(label: string): DisplayStep {
  return { key: label, label, stepIds: [label] };
}

function renderStepper(state: LogRunState, steps: readonly DisplayStep[]) {
  const rows = buildRunStepperSteps(runStateFromLog(state), steps);
  return render(<HorizontalStepper steps={rows} />);
}

// The indicator div carries the status colour class; the glyph it contains
// (✓ for completed, ! for failed, the step number otherwise) is unique per row.
function indicatorFor(glyph: string): HTMLElement {
  return screen.getByText(glyph);
}

afterEach(() => cleanup());

describe("log-derived stepper rendering", () => {
  it("renders a failed step as failed (not current), completed steps done, later steps pending", () => {
    const steps = [
      display("intake"),
      display("generate"),
      display("review"),
      display("publish"),
    ];
    renderStepper(
      logState({
        phase: "failed",
        steps: [
          {
            stepId: "intake",
            phase: "completed",
            stepType: "human",
            currentAttempt: 1,
          },
          {
            stepId: "generate",
            phase: "failed",
            stepType: "agent",
            currentAttempt: 1,
            lastError: { message: "boom" },
          },
        ],
      }),
      steps,
    );

    // intake completed → ✓, green.
    expect(indicatorFor("✓").className).toContain("bg-green");
    // generate failed → !, red — the CL-2654 concern: NOT a current/orange dot.
    const failed = indicatorFor("!");
    expect(failed.className).toContain("bg-red");
    expect(failed.className).not.toContain("bg-orange");
    // downstream steps stay pending (neutral), never current.
    expect(indicatorFor("3").className).toContain("bg-surface-2");
    expect(indicatorFor("4").className).toContain("bg-surface-2");
  });

  it("renders an awaiting-signal step as the active (current) gate", () => {
    const steps = [display("intake"), display("review"), display("publish")];
    renderStepper(
      logState({
        steps: [
          {
            stepId: "intake",
            phase: "completed",
            stepType: "deterministic",
            currentAttempt: 1,
          },
          {
            stepId: "review",
            phase: "awaiting-signal",
            stepType: "human",
            currentAttempt: 1,
            awaitingSignalName: "approve",
          },
        ],
      }),
      steps,
    );

    expect(indicatorFor("✓").className).toContain("bg-green");
    // review is the active gate → current/orange, showing its number (2).
    expect(indicatorFor("2").className).toContain("bg-orange");
    // publish is still pending.
    expect(indicatorFor("3").className).toContain("bg-surface-2");
  });

  it("keeps a failed step failed even when a later concurrent step has completed", () => {
    // Independent DAG steps run concurrently: a later step's progress must not
    // re-label the failed step as passed (CL-2654 follow-up).
    const steps = [display("a"), display("b"), display("c")];
    renderStepper(
      logState({
        phase: "failed",
        steps: [
          {
            stepId: "a",
            phase: "failed",
            stepType: "agent",
            currentAttempt: 1,
            lastError: { message: "nope" },
          },
          {
            stepId: "c",
            phase: "completed",
            stepType: "deterministic",
            currentAttempt: 1,
          },
        ],
      }),
      steps,
    );

    const failed = indicatorFor("!");
    expect(failed.className).toContain("bg-red");
    expect(failed.className).not.toContain("bg-green");
  });
});
