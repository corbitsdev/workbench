import { describe, expect, it, mock } from "bun:test";

const driveGateMock = mock(async () => ({ ok: true as const }));

mock.module("../workflow-executor/pending-gate-info", () => ({
  describePendingGates: mock(async () => [
    { signalName: "intake" },
    { signalName: "confirm" },
  ]),
}));

mock.module("../workflow-executor/run-store", () => ({
  loadRunRecord: mock(async () => ({ triggerSource: "scheduler" })),
  setRunStatus: mock(async () => undefined),
}));

mock.module("../lib/workflow-catalog", () => ({
  loadWorkflowGateInfos: mock(
    async () =>
      new Map([["gamma", { requiresIntake: true, humanGateCount: 2 }]]),
  ),
}));

const { createScheduledWorkflowGateAgent } = await import(
  "./scheduled-workflow-gate-agent"
);

describe("scheduled gate maybeEnqueue", () => {
  it("skips post-intake drive when the kind is not allowlisted or flagged", async () => {
    const agent = createScheduledWorkflowGateAgent({
      db: { query: {} } as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      cryptoProvider: {} as never,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      driveGate: driveGateMock,
    });

    driveGateMock.mockClear();
    agent.maybeEnqueue({
      runId: "run-1",
      kind: "gamma",
      tenantId: "ten-1",
      principalId: "pri-1",
      deploymentId: "dep-1",
      repoStore: {} as never,
    });
    await agent.waitForDrain();

    expect(driveGateMock).not.toHaveBeenCalled();
  });
});