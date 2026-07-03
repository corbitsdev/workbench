import { describe, expect, it } from "bun:test";
import {
  pendingGateForRun,
  routeConversationSignal,
  type PendingGate,
} from "./conversation-gates";

describe("pendingGateForRun", () => {
  it("returns the awaiting-signal step's recovered gate", () => {
    const gate = pendingGateForRun({
      runId: "run_1",
      runKind: "pain-point-collateral",
      steps: [
        { phase: "completed" },
        { phase: "awaiting-signal", awaitingSignalName: "review-draft" },
        { phase: "in-flight" },
      ],
    });
    expect(gate).toEqual({
      runId: "run_1",
      runKind: "pain-point-collateral",
      signalName: "review-draft",
    });
  });

  it("returns null when a gate is awaiting but its signalName is unrecoverable", () => {
    expect(
      pendingGateForRun({
        runId: "run_1",
        runKind: "k",
        steps: [{ phase: "awaiting-signal" }],
      }),
    ).toBeNull();
  });

  it("returns null when no step is parked on a gate", () => {
    expect(
      pendingGateForRun({
        runId: "run_1",
        runKind: "k",
        steps: [{ phase: "completed" }, { phase: "in-flight" }],
      }),
    ).toBeNull();
  });

  it("ignores an awaiting-timer step — only signal gates are human-routable", () => {
    expect(
      pendingGateForRun({
        runId: "run_1",
        runKind: "k",
        steps: [{ phase: "awaiting-timer", awaitingSignalName: "nope" }],
      }),
    ).toBeNull();
  });
});

describe("routeConversationSignal", () => {
  const gate = (runId: string): PendingGate => ({
    runId,
    runKind: "k",
    signalName: `sig-${runId}`,
  });

  it("routes free text to the sole gate when exactly one is pending", () => {
    expect(routeConversationSignal([gate("run_1")])).toEqual({
      mode: "single",
      gate: gate("run_1"),
    });
  });

  it("does NOT auto-route when more than one gate is pending", () => {
    const routing = routeConversationSignal([gate("run_1"), gate("run_2")]);
    expect(routing.mode).toBe("multi");
    if (routing.mode !== "multi") throw new Error("expected multi");
    expect(routing.gates).toHaveLength(2);
  });

  it("is a no-op when no gate is pending", () => {
    expect(routeConversationSignal([])).toEqual({ mode: "none" });
  });
});
