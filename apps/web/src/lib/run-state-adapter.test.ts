/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  isLogStateTerminal,
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
  type RunRecord,
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

describe("reconcileRunState — index status is authoritative for run-level terminal", () => {
  const record = (status: RunRecord["status"]): RunRecord => ({
    runId: "wfr_1",
    kind: "brief",
    status,
  });

  it("surfaces the index `failed` over a still-pending log phase (swept/aborted run)", () => {
    // The empty-log hang: the sweep (or an operator abort) writes `failed` only
    // to the index; the log fold never saw a terminal event, so it stays
    // `pending`. The reconciled state must read terminal-`failed`, not the log's
    // live-looking `pending`, so the pane stops and shows failed.
    const log = runStateFromLog(logState({ phase: "pending" }));
    const reconciled = reconcileRunState(record("failed"), log);
    expect(reconciled.phase).toBe("failed");
  });

  it("surfaces the index `failed` over a running log phase", () => {
    const log = runStateFromLog(logState({ phase: "running" }));
    expect(reconcileRunState(record("failed"), log).phase).toBe("failed");
  });

  it("leaves a non-terminal index status alone (running run passes the log through)", () => {
    const log = runStateFromLog(logState({ phase: "running" }));
    expect(reconcileRunState(record("running"), log).phase).toBe("running");
  });

  it("does not downgrade a log that is already terminal", () => {
    const log = runStateFromLog(logState({ phase: "completed" }));
    expect(reconcileRunState(record("failed"), log).phase).toBe("completed");
  });
});

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

describe("stepOutputsFromLog", () => {
  it("decodes each step's inline: outputRef into the stepId -> output map", () => {
    const outputs = stepOutputsFromLog(
      logState({
        steps: [
          {
            stepId: "analyze",
            phase: "completed",
            stepType: "inline",
            currentAttempt: 1,
            outputRef: `inline:${JSON.stringify({ reply: "hello" })}`,
          },
          {
            stepId: "curate",
            phase: "completed",
            stepType: "agent",
            currentAttempt: 1,
            outputRef: `inline:${JSON.stringify([{ callId: "c1" }])}`,
          },
        ],
      }),
    );
    expect(outputs).toEqual({
      analyze: { reply: "hello" },
      curate: [{ callId: "c1" }],
    });
  });

  it("omits steps with no outputRef and blob: refs it cannot resolve client-side", () => {
    const outputs = stepOutputsFromLog(
      logState({
        steps: [
          {
            stepId: "intake",
            phase: "awaiting-signal",
            stepType: "human",
            currentAttempt: 1,
          },
          {
            stepId: "huge",
            phase: "completed",
            stepType: "agent",
            currentAttempt: 1,
            outputRef: "blob:" + "a".repeat(64),
          },
          {
            stepId: "small",
            phase: "completed",
            stepType: "deterministic",
            currentAttempt: 1,
            outputRef: 'inline:{"ok":true}',
          },
        ],
      }),
    );
    expect(outputs).toEqual({ small: { ok: true } });
  });

  it("returns an empty map for a run with no steps", () => {
    expect(stepOutputsFromLog(logState({}))).toEqual({});
  });

  it("lets sibling steps decode when one step's inline blob is malformed JSON", () => {
    const outputs = stepOutputsFromLog(
      logState({
        steps: [
          {
            stepId: "good",
            phase: "completed",
            stepType: "deterministic",
            currentAttempt: 1,
            outputRef: 'inline:{"ok":true}',
          },
          {
            stepId: "broken",
            phase: "completed",
            stepType: "agent",
            currentAttempt: 1,
            outputRef: "inline:{not json",
          },
          {
            stepId: "also-good",
            phase: "completed",
            stepType: "inline",
            currentAttempt: 1,
            outputRef: `inline:${JSON.stringify({ n: 2 })}`,
          },
        ],
      }),
    );
    // The malformed step is simply omitted (its raw ref renders the honest
    // note); its siblings still decode. A whole-run catch would drop all three.
    expect(outputs).toEqual({ good: { ok: true }, "also-good": { n: 2 } });
    expect("broken" in outputs).toBe(false);
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
