import { describe, expect, test } from "bun:test";

import { deriveRunFacts } from "./workflow-run-facts";
import type { LogRunState } from "./run-state-from-log";

// Pure derivation from a log-folded RunState to flat facts. No DB, no repo — the
// mapping (outcome, step-kind, duration, gate-wait, terminal-step filtering) is a
// total function of the RunState and is unit-tested here.

function state(overrides: Partial<LogRunState> = {}): LogRunState {
  return {
    runId: "wfr-1",
    phase: "failed",
    lastSeq: 10,
    startedAt: "2026-01-01T00:00:01.000Z",
    endedAt: "2026-01-01T00:00:15.000Z",
    steps: [],
    ...overrides,
  };
}

describe("deriveRunFacts", () => {
  test("run fact carries outcome + wall-clock duration", () => {
    const { run } = deriveRunFacts(state(), { tenantId: "tn", kind: "brief" });
    expect(run.outcome).toBe("failed");
    expect(run.durationMs).toBe(14_000);
    expect(run.tenantId).toBe("tn");
    expect(run.kind).toBe("brief");
  });

  test("completed run maps to the completed outcome", () => {
    const { run } = deriveRunFacts(state({ phase: "completed" }), {
      tenantId: "tn",
      kind: "brief",
    });
    expect(run.outcome).toBe("completed");
  });

  test("cancelled phase is preserved (not folded into failed)", () => {
    const { run } = deriveRunFacts(state({ phase: "cancelled" }), {
      tenantId: "tn",
      kind: "brief",
    });
    expect(run.outcome).toBe("cancelled");
  });

  test("step facts carry kind, outcome, attempt, duration, and gate-wait", () => {
    const { steps } = deriveRunFacts(
      state({
        steps: [
          {
            stepId: "fetch",
            phase: "completed",
            stepType: "deterministic",
            currentAttempt: 2,
            startedAt: "2026-01-01T00:00:02.000Z",
            endedAt: "2026-01-01T00:00:07.000Z",
          },
          {
            stepId: "approve",
            phase: "completed",
            stepType: "human",
            currentAttempt: 1,
            startedAt: "2026-01-01T00:00:08.000Z",
            endedAt: "2026-01-01T00:00:12.000Z",
            gateWaitMs: 2_000,
          },
          {
            stepId: "score",
            phase: "failed",
            stepType: "agent",
            currentAttempt: 1,
            startedAt: "2026-01-01T00:00:13.000Z",
            endedAt: "2026-01-01T00:00:14.000Z",
          },
        ],
      }),
      { tenantId: "tn", kind: "brief" },
    );
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    expect(byId.get("fetch")).toMatchObject({
      stepKind: "deterministic",
      outcome: "completed",
      attempt: 2,
      durationMs: 5_000,
    });
    expect(byId.get("approve")).toMatchObject({
      stepKind: "human",
      outcome: "completed",
      gateWaitMs: 2_000,
      durationMs: 4_000,
    });
    expect(byId.get("score")).toMatchObject({
      stepKind: "agent",
      outcome: "failed",
      durationMs: 1_000,
    });
  });

  test("unknown step type is recorded as 'other'", () => {
    const { steps } = deriveRunFacts(
      state({
        steps: [
          {
            stepId: "x",
            phase: "completed",
            stepType: "unknown",
            currentAttempt: 1,
          },
        ],
      }),
      { tenantId: "tn", kind: "brief" },
    );
    expect(steps[0]?.stepKind).toBe("other");
  });

  test("non-terminal steps (still in-flight / at a gate) are excluded", () => {
    const { steps } = deriveRunFacts(
      state({
        steps: [
          {
            stepId: "waiting",
            phase: "awaiting-signal",
            stepType: "human",
            currentAttempt: 1,
          },
          {
            stepId: "running",
            phase: "in-flight",
            stepType: "agent",
            currentAttempt: 1,
          },
          {
            stepId: "done",
            phase: "completed",
            stepType: "agent",
            currentAttempt: 1,
          },
        ],
      }),
      { tenantId: "tn", kind: "brief" },
    );
    expect(steps.map((s) => s.stepId)).toEqual(["done"]);
  });
});
