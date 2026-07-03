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

  it("is multi even when two runs share the SAME signalName — the run, not the name, disambiguates", () => {
    const sameName = (runId: string): PendingGate => ({
      runId,
      runKind: "pain-point-collateral",
      signalName: "review-draft",
    });
    const routing = routeConversationSignal([
      sameName("run_1"),
      sameName("run_2"),
    ]);
    expect(routing.mode).toBe("multi");
    if (routing.mode !== "multi") throw new Error("expected multi");
    expect(routing.gates.map((g) => g.runId)).toEqual(["run_1", "run_2"]);
  });

  it("is a no-op when the only awaiting run's signal is unrecoverable (folded from run state)", () => {
    // A conversation with one awaiting run whose gate name never made it into
    // the log: pendingGateForRun yields null, so the conversation has zero
    // routable gates → free text stays a normal chat turn.
    const gates = [
      pendingGateForRun({
        runId: "run_1",
        runKind: "pain-point-collateral",
        steps: [{ phase: "awaiting-signal" }],
      }),
    ].filter((g): g is PendingGate => g !== null);
    expect(routeConversationSignal(gates)).toEqual({ mode: "none" });
  });
});
