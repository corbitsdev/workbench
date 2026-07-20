/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApproval } from "../lib/approvals-api";

// Cold page reload: an EMPTY query cache, and NO SSE event ever fired. The card
// must reconstruct entirely from two server-persisted sources fetched on mount —
// the pending-approvals list and the thread's turns — proving it does not depend
// on any in-memory / SSE-only state to survive a reload.

const PENDING_APPROVAL: NativeApproval = {
  id: "apr-cold-1",
  tenantId: "tenant-1",
  deploymentId: "dep-1",
  runId: "run-1",
  agentAddress: "ins_dep-1@agents.example.com",
  correlationId: "corr-1",
  // No snapshot — enrichment was dropped in the runtime. Args must come from
  // the reloaded transcript.
  toolDefinition: null,
  toolArguments: null,
  scope: null,
  status: "pending",
  timeoutAt: null,
  resolvedAt: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

let listCalls = 0;
const mockListNativeApprovals = mock(async () => {
  listCalls += 1;
  return [PENDING_APPROVAL];
});
// subscribeApprovals must NOT be the thing that populates the card. It returns a
// noop unsubscribe and is never invoked with an event in this test.
const mockSubscribeApprovals = mock(() => () => {});
mock.module("../lib/approvals-api", () => ({
  subscribeApprovals: mockSubscribeApprovals,
  listNativeApprovals: mockListNativeApprovals,
  approveNativeRequest: mock(async () => PENDING_APPROVAL),
  rejectNativeRequest: mock(async () => PENDING_APPROVAL),
}));

// The turns endpoint, still holding the suspended tool_use (no result yet)
// because the tool is parked server-side awaiting approval. hubFetch is the
// only network boundary the turns hook touches.
let turnsCalls = 0;
mock.module("../lib/hub-api", () => ({
  hubFetch: mock(async (_method: string, path: string) => {
    if (path.includes("/turns")) {
      turnsCalls += 1;
      return {
        data: [
          {
            parts: [
              {
                type: "tool",
                metadata: {
                  kind: "call",
                  callId: "call_1",
                  name: "slack__post_message",
                  arguments: { channel: "#gtm", text: "hi" },
                },
              },
            ],
          },
        ],
      };
    }
    return { data: [] };
  }),
}));

// The lookups hook is stubbed to empty — address→instance scoping resolves the
// `ins_` local-part directly from the approval row, so this fetch is irrelevant
// to the cold-load proof.
mock.module("../hooks/use-approval-display-lookups", () => ({
  useApprovalDisplayLookups: () => ({
    lookups: {
      principalById: new Map(),
      principalByRefId: new Map(),
      agentByInstanceId: new Map(),
      agentByAddress: new Map(),
      instanceIdByAddress: new Map(),
    },
    isLoading: false,
  }),
}));

function renderColdGate(openInstanceId: string | null) {
  const { ReviewGate } =
    require("./ReviewGate") as typeof import("./ReviewGate");
  // A brand-new client: no seeded cache, mirroring a fresh page load.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ReviewGate, { tenantId: "tenant-1", openInstanceId }),
    ),
  );
}

beforeEach(() => {
  listCalls = 0;
  turnsCalls = 0;
});

afterEach(() => {
  cleanup();
});

describe("ReviewGate — survives a cold page reload (CL-3940)", () => {
  it("reconstructs the card + args from fetched-on-mount server state, no SSE event", async () => {
    renderColdGate("ins_dep-1");

    // The card appears from the initial approvals fetch — no SSE event was ever
    // delivered.
    await waitFor(() => {
      screen.getByTestId("native-approval-apr-cold-1");
    });

    // The action + args are re-derived from the reloaded transcript's still-
    // suspended tool call.
    await waitFor(() => {
      screen.getByText("Posting to Slack #gtm");
    });
    screen.getByText("channel: #gtm · text: hi");

    // Both server sources were fetched on mount; the card did not wait on an
    // SSE push.
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(turnsCalls).toBeGreaterThanOrEqual(1);
    // No neutral fallback — the args resolved.
    expect(screen.queryByText(/Approval requested by ins_dep-1/)).toBeNull();
  });

  it("still does not render the card for a different thread after a cold reload", async () => {
    renderColdGate("ins_other");
    await waitFor(() => {
      expect(listCalls).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByTestId("native-approval-apr-cold-1")).toBeNull();
    expect(screen.queryByTestId("review-gate")).toBeNull();
  });

  it("still does not render the card in a new/empty chat after a cold reload", async () => {
    renderColdGate(null);
    // A null open instance disables the turns query and shows no card.
    await waitFor(() => {
      expect(mockSubscribeApprovals).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("review-gate")).toBeNull();
  });
});
