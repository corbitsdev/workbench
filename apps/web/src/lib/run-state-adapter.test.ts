/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  isRecordTerminal,
  runStateFromRecord,
  type RunRecord,
} from "./run-state-adapter";

function record(over: Partial<RunRecord>): RunRecord {
  return {
    runId: "wfr_1",
    kind: "pain-point-collateral",
    status: "running",
    currentStepId: null,
    outputs: {},
    ...over,
  };
}

describe("isRecordTerminal", () => {
  it("treats only completed/failed as terminal, not awaiting", () => {
    expect(isRecordTerminal("completed")).toBe(true);
    expect(isRecordTerminal("failed")).toBe(true);
    expect(isRecordTerminal("awaiting")).toBe(false);
    expect(isRecordTerminal("running")).toBe(false);
  });
});

describe("runStateFromRecord", () => {
  it("marks every step with an output as completed and exposes an outputRef", () => {
    const state = runStateFromRecord(
      record({
        outputs: { intake: { content: "[]" }, analyze: { reply: "{}" } },
      }),
    );
    expect(state.steps.get("intake")?.phase).toBe("completed");
    expect(state.steps.get("intake")?.outputRef).toBeDefined();
    expect(state.steps.get("analyze")?.phase).toBe("completed");
  });

  it("parks the current step on a signal gate when status is awaiting", () => {
    const state = runStateFromRecord(
      record({ status: "awaiting", currentStepId: "context" }),
    );
    expect(state.phase).toBe("running");
    expect(state.steps.get("context")?.phase).toBe("awaiting-signal");
    expect(state.steps.get("context")?.awaitingSignal?.name).toBe("context");
  });

  it("marks the current step in-flight while a non-gate step runs", () => {
    const state = runStateFromRecord(
      record({ status: "running", currentStepId: "analyze" }),
    );
    expect(state.steps.get("analyze")?.phase).toBe("in-flight");
  });

  it("propagates a failed run onto the active step with its error", () => {
    const state = runStateFromRecord(
      record({ status: "failed", currentStepId: "generate", error: "boom" }),
    );
    expect(state.phase).toBe("failed");
    expect(state.steps.get("generate")?.phase).toBe("failed");
    expect(state.steps.get("generate")?.lastError?.message).toBe("boom");
  });

  it("maps a completed run to a completed run phase", () => {
    const state = runStateFromRecord(
      record({ status: "completed", outputs: { persist: {} } }),
    );
    expect(state.phase).toBe("completed");
  });

  it("does not overwrite a completed step that is also the current step", () => {
    const state = runStateFromRecord(
      record({
        status: "running",
        currentStepId: "intake",
        outputs: { intake: { content: "[]" } },
      }),
    );
    expect(state.steps.get("intake")?.phase).toBe("completed");
  });
});
