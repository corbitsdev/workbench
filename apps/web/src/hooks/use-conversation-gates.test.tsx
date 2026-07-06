/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as apiActual from "../lib/api";

let records: unknown = [];
let statesByRunId: Record<string, unknown> = {};

async function fakeApi(_method: string, path: string): Promise<unknown> {
  if (path.includes("originConversationId=")) return records;
  const stateMatch = /\/workflow-exec\/runs\/([^/]+)\/state/.exec(path);
  if (stateMatch?.[1] !== undefined) {
    const state = statesByRunId[stateMatch[1]];
    if (state === undefined) throw new Error(`no state for ${stateMatch[1]}`);
    return state;
  }
  throw new Error(`unexpected api call: ${path}`);
}

mock.module("../lib/api", () => ({ ...apiActual, api: fakeApi }));

const { useConversationGates } = require("./use-conversation-gates");

function listRow(runId: string, status: string, kind = "k") {
  return {
    runId,
    kind,
    status,
    createdAt: "2026-07-02T10:00:00.000Z",
    originConversationId: "conv-1",
  };
}

function logState(
  runId: string,
  steps: { stepId: string; phase: string; awaitingSignalName?: string }[],
) {
  return {
    runId,
    phase: "running",
    lastSeq: steps.length,
    steps: steps.map((s) => ({
      stepType: "deterministic",
      currentAttempt: 1,
      ...s,
    })),
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  );
}

beforeEach(() => {
  records = [];
  statesByRunId = {};
});

afterEach(() => {
  queryClient?.clear();
  cleanup();
});

describe("useConversationGates", () => {
  it("resolves to single-gate routing when one run is awaiting a recoverable signal", async () => {
    records = [
      listRow("run_a", "running"),
      listRow("run_gate", "awaiting", "pain-point-collateral"),
    ];
    statesByRunId["run_gate"] = logState("run_gate", [
      {
        stepId: "review",
        phase: "awaiting-signal",
        awaitingSignalName: "approve",
      },
    ]);

    const { result } = renderHook(() => useConversationGates("conv-1", null), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mode).toBe("single"));
    if (result.current.mode !== "single") throw new Error("expected single");
    expect(result.current.gate).toEqual({
      runId: "run_gate",
      runKind: "pain-point-collateral",
      signalName: "approve",
    });
  });

  it("resolves to multi routing when two runs are awaiting recoverable signals", async () => {
    records = [listRow("run_1", "awaiting"), listRow("run_2", "awaiting")];
    statesByRunId["run_1"] = logState("run_1", [
      { stepId: "g", phase: "awaiting-signal", awaitingSignalName: "a" },
    ]);
    statesByRunId["run_2"] = logState("run_2", [
      { stepId: "g", phase: "awaiting-signal", awaitingSignalName: "b" },
    ]);

    const { result } = renderHook(() => useConversationGates("conv-1", null), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mode).toBe("multi"));
    if (result.current.mode !== "multi") throw new Error("expected multi");
    expect(result.current.gates).toHaveLength(2);
  });

  it("is 'none' when no run is parked on a resolvable gate", async () => {
    records = [listRow("run_a", "running")];

    const { result } = renderHook(() => useConversationGates("conv-1", null), {
      wrapper,
    });

    // Give the run list a tick to load; a running run holds no gate.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current.mode).toBe("none");
  });
});
