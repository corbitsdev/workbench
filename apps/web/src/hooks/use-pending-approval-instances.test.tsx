/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApproval } from "../lib/approvals-api";
import type { AgentInstance } from "../lib/hub-api";

// The approvals + instances API boundaries the hook fetches on mount, and the
// SSE subscription. The subscription is a no-op here (returns an unsubscribe):
// the point of these tests is that a COLD load with an empty cache populates
// the set from the initial fetch, with no SSE event ever delivered.
let approvals: NativeApproval[] = [];
let instances: AgentInstance[] = [];
const listNativeApprovals = mock(() => Promise.resolve(approvals));
const listAgentInstances = mock(() => Promise.resolve(instances));
const subscribeApprovals = mock(() => () => {});

mock.module("../lib/approvals-api", () => ({
  listNativeApprovals,
  subscribeApprovals,
}));
mock.module("../lib/hub-api", () => ({
  listAgentInstances,
}));
mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "tenant-1" }),
}));

const {
  usePendingApprovalInstances,
} = require("./use-pending-approval-instances");

function approval(over: Partial<NativeApproval>): NativeApproval {
  return {
    id: "apr-1",
    tenantId: "tenant-1",
    deploymentId: "dep-1",
    runId: "run-1",
    agentAddress: "ins_alpha@agents.example.com",
    correlationId: "corr-1",
    toolDefinition: null,
    toolArguments: null,
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

function instance(over: Partial<AgentInstance>): AgentInstance {
  return {
    id: "ins_alpha",
    agentId: "agt_1",
    agentName: "Myra",
    tenantId: "tenant-1",
    address: "ins_alpha@agents.example.com",
    status: "active",
    credentialRequirements: [],
    capabilities: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

function Probe() {
  const pending = usePendingApprovalInstances();
  return React.createElement(
    "div",
    { "data-testid": "probe" },
    pending.has("ins_alpha") ? "has-alpha" : "none",
  );
}

function renderProbe() {
  // A fresh QueryClient with an empty cache — nothing seeded — simulates a cold
  // page reload.
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(Probe),
    ),
  );
}

afterEach(() => {
  cleanup();
  approvals = [];
  instances = [];
  listNativeApprovals.mockClear();
  listAgentInstances.mockClear();
  subscribeApprovals.mockClear();
});

describe("usePendingApprovalInstances cold-load persistence", () => {
  it("populates the pending set from the on-mount fetch, without any SSE event", async () => {
    approvals = [approval({})];
    instances = [instance({})];
    renderProbe();

    // Starts empty (fetch in flight), then resolves from the fetched list. No
    // SSE frame is ever emitted, proving the dot survives a cold reload.
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("has-alpha"),
    );
    expect(listNativeApprovals).toHaveBeenCalled();
  });

  it("resolves to empty when the fetched list has no pending approval for an instance", async () => {
    approvals = [];
    instances = [instance({})];
    renderProbe();
    await waitFor(() => expect(listNativeApprovals).toHaveBeenCalled());
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
