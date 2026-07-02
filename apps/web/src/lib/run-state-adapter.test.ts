/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  isLogStateTerminal,
  isRecordTerminal,
  runStateFromLog,
  type LogRunState,
} from "./run-state-adapter";

describe("isRecordTerminal", () => {
  it("treats only completed/failed as terminal, not awaiting", () => {
    expect(isRecordTerminal("completed")).toBe(true);
    expect(isRecordTerminal("failed")).toBe(true);
    expect(isRecordTerminal("awaiting")).toBe(false);
    expect(isRecordTerminal("running")).toBe(false);
  });
});

function logState(over: Partial<LogRunState>): LogRunState {
  return {
    runId: "wfr_1",
    phase: "running",
    lastSeq: 0,
    steps: [],
    ...over,
  };
}

describe("isLogStateTerminal", () => {
  it("treats completed, failed, and cancelled as terminal — not running/pending/awaiting", () => {
    expect(isLogStateTerminal("completed")).toBe(true);
    expect(isLogStateTerminal("failed")).toBe(true);
    expect(isLogStateTerminal("cancelled")).toBe(true);
    expect(isLogStateTerminal("running")).toBe(false);
    expect(isLogStateTerminal("pending")).toBe(false);
    expect(isLogStateTerminal("cancelling")).toBe(false);
  });
});

describe("runStateFromLog", () => {
  it("carries each step's log phase through verbatim (failed stays failed, not synthesized)", () => {
    const state = runStateFromLog(
      logState({
        phase: "failed",
        steps: [
          {
            stepId: "intake",
            phase: "completed",
            stepType: "human",
            currentAttempt: 1,
            outputRef: "artifact:abc",
          },
          {
            stepId: "generate",
            phase: "failed",
            stepType: "agent",
            currentAttempt: 2,
            lastError: { message: "model refused" },
          },
        ],
      }),
    );
    expect(state.phase).toBe("failed");
    expect(state.steps.get("intake")?.phase).toBe("completed");
    expect(state.steps.get("intake")?.outputRef).toBe("artifact:abc");
    expect(state.steps.get("generate")?.phase).toBe("failed");
    expect(state.steps.get("generate")?.currentAttempt).toBe(2);
    expect(state.steps.get("generate")?.lastError?.message).toBe(
      "model refused",
    );
  });

  it("maps an awaiting-signal step to the native awaitingSignal gate", () => {
    const state = runStateFromLog(
      logState({
        steps: [
          {
            stepId: "review",
            phase: "awaiting-signal",
            stepType: "human",
            currentAttempt: 1,
            awaitingSignalName: "approve-draft",
          },
        ],
      }),
    );
    expect(state.steps.get("review")?.phase).toBe("awaiting-signal");
    expect(state.steps.get("review")?.awaitingSignal?.name).toBe(
      "approve-draft",
    );
  });

  it("carries the run phase and lastSeq and starts with empty child/timer/signal maps", () => {
    const state = runStateFromLog(logState({ phase: "completed", lastSeq: 7 }));
    expect(state.phase).toBe("completed");
    expect(state.lastSeq).toBe(7);
    expect(state.children.size).toBe(0);
    expect(state.pendingTimers.size).toBe(0);
  });
});
