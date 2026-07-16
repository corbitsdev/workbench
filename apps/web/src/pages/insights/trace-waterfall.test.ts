/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import type { LogStepState } from "../../lib/run-state-adapter";
import {
  buildTraceWaterfallLayout,
  formatStepDuration,
  stepSpanMs,
  waterfallBarStyle,
} from "./trace-waterfall";

function step(
  partial: Partial<LogStepState> & Pick<LogStepState, "stepId" | "phase">,
): LogStepState {
  return {
    stepType: "agent",
    currentAttempt: 1,
    ...partial,
  };
}

describe("formatStepDuration", () => {
  it("returns null unless both boundaries are present", () => {
    expect(
      formatStepDuration(undefined, "2026-07-01T10:00:02.000Z"),
    ).toBeNull();
    expect(
      formatStepDuration("2026-07-01T10:00:00.000Z", undefined),
    ).toBeNull();
  });

  it("never invents a negative span", () => {
    expect(
      formatStepDuration(
        "2026-07-01T10:00:05.000Z",
        "2026-07-01T10:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("formats a real span honestly", () => {
    expect(
      formatStepDuration(
        "2026-07-01T10:00:00.000Z",
        "2026-07-01T10:00:02.000Z",
      ),
    ).toBe("2.0s");
  });
});

describe("buildTraceWaterfallLayout", () => {
  it("marks missing end time without fabricating span width", () => {
    const layout = buildTraceWaterfallLayout([
      step({
        stepId: "a",
        phase: "in-flight",
        startedAt: "2026-07-01T10:00:00.000Z",
      }),
    ]);
    expect(layout.rows[0]?.spanMs).toBeNull();
    expect(layout.rows[0]?.missingEnd).toBe(true);
    expect(waterfallBarStyle(layout, layout.rows[0]!)).toBeNull();
  });

  it("lays out proportional bars from timestamps", () => {
    const layout = buildTraceWaterfallLayout([
      step({
        stepId: "a",
        phase: "completed",
        startedAt: "2026-07-01T10:00:00.000Z",
        endedAt: "2026-07-01T10:00:02.000Z",
      }),
      step({
        stepId: "b",
        phase: "failed",
        startedAt: "2026-07-01T10:00:02.000Z",
        endedAt: "2026-07-01T10:00:05.000Z",
      }),
    ]);
    expect(stepSpanMs(layout.rows[0]!.step.startedAt, layout.rows[0]!.step.endedAt)).toBe(
      2000,
    );
    const first = waterfallBarStyle(layout, layout.rows[0]!);
    const second = waterfallBarStyle(layout, layout.rows[1]!);
    expect(first?.leftPercent).toBe(0);
    expect(second?.leftPercent).toBeCloseTo(40, 0);
    expect(first?.widthPercent).toBeCloseTo(40, 0);
    expect(second?.widthPercent).toBeCloseTo(60, 0);
  });
});
