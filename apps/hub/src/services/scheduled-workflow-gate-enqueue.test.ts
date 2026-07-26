import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../config", () => ({
  getConfig: () => ({ featureGrantCacheTtlMs: 30_000 }),
  requireCredentialEncryptionKey: () => Buffer.alloc(32),
}));

mock.module("./agent-provisioning", () => ({
  launchAgentSession: mock(async () => ({
    address: "inst@tenant.example",
    sessionId: "ses-1",
  })),
}));

mock.module("./myra-threads", () => ({
  resolveMyraDefinition: mock(async () => ({
    id: "agt_myra",
    tenantId: "ten-1",
    name: "Myra",
    modelConfig: { defaultModel: "deepseek-v4-flash" },
  })),
  teardownThreadRows: mock(async () => undefined),
}));

const failRunIfStillAwaitingMock = mock(async () => true);
const deliverRunTerminalMailMock = mock(async () => undefined);

let releaseBlockedDrive: (() => void) | undefined;
const blockingDriveGateMock = mock(async () => {
  await new Promise<void>((resolve) => {
    releaseBlockedDrive = resolve;
  });
  return { ok: true as const };
});

const happyDriveGateMock = mock(async () => ({ ok: true as const }));

mock.module("../workflow-executor/pending-gate-info", () => ({
  describePendingGates: mock(async () => [
    { signalName: "intake" },
    { signalName: "confirm" },
  ]),
}));

mock.module("../workflow-executor/run-store", () => ({
  loadRunRecord: mock(async () => ({ triggerSource: "scheduler" })),
  failRunIfStillAwaiting: failRunIfStillAwaitingMock,
  touchRunRecordUpdatedAt: mock(async () => undefined),
  setPendingSignal: mock(async () => undefined),
  loadDeploymentMeta: mock(async () => null),
}));

mock.module("../workflow-executor/run-terminal-mail", () => ({
  deliverRunTerminalMail: deliverRunTerminalMailMock,
}));

const { createScheduledWorkflowGateAgent } = await import(
  "./scheduled-workflow-gate-agent"
);

const BASE = {
  kind: "allowed-multi",
  tenantId: "ten-1",
  principalId: "pri-1",
  deploymentId: "dep-1",
  repoStore: {} as never,
};

beforeEach(() => {
  happyDriveGateMock.mockClear();
  blockingDriveGateMock.mockClear();
  failRunIfStillAwaitingMock.mockClear();
  deliverRunTerminalMailMock.mockClear();
  releaseBlockedDrive = undefined;
});

describe("scheduled gate maybeEnqueue", () => {
  it("drives post-intake gates for any multi-gate kind — no eligibility check gates it (CL-4514)", async () => {
    const agent = createScheduledWorkflowGateAgent({
      db: { query: {} } as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      cryptoProvider: {} as never,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      driveGate: happyDriveGateMock,
    });

    await agent.maybeEnqueue({ runId: "run-1", ...BASE, kind: "gamma" });
    await agent.waitForDrain();

    expect(happyDriveGateMock).toHaveBeenCalledTimes(1);
    expect(happyDriveGateMock.mock.calls[0]![0]).toMatchObject({
      runId: "run-1",
      kind: "gamma",
      signalName: "confirm",
    });
    expect(failRunIfStillAwaitingMock).not.toHaveBeenCalled();
  });

  it("calls driveGate for post-intake gates on an allowed scheduler run", async () => {
    const agent = createScheduledWorkflowGateAgent({
      db: { query: {} } as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      cryptoProvider: {} as never,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      driveGate: happyDriveGateMock,
    });

    await agent.maybeEnqueue({ runId: "run-happy", ...BASE });
    await agent.waitForDrain();

    expect(happyDriveGateMock).toHaveBeenCalledTimes(1);
    expect(happyDriveGateMock.mock.calls[0]![0]).toMatchObject({
      runId: "run-happy",
      kind: "allowed-multi",
      signalName: "confirm",
    });
  });

  it("fails the run when the drive queue is full", async () => {
    const agent = createScheduledWorkflowGateAgent({
      db: { query: {} } as never,
      sessionService: {} as never,
      grantStore: {} as never,
      eventCollectors: {} as never,
      cryptoProvider: {} as never,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      driveGate: blockingDriveGateMock,
      maxQueue: 1,
    });

    await agent.maybeEnqueue({ runId: "run-blocked", ...BASE });
    for (let i = 0; i < 50; i++) {
      if (blockingDriveGateMock.mock.calls.length > 0) break;
      await Bun.sleep(5);
    }
    expect(blockingDriveGateMock.mock.calls.length).toBeGreaterThan(0);
    await agent.maybeEnqueue({ runId: "run-queued", ...BASE });
    await agent.maybeEnqueue({ runId: "run-overflow", ...BASE });

    expect(failRunIfStillAwaitingMock).toHaveBeenCalled();
    expect(deliverRunTerminalMailMock).toHaveBeenCalled();
    const terminalArgs = deliverRunTerminalMailMock.mock.calls[0]![1] as {
      runId: string;
      error: string;
    };
    expect(terminalArgs.runId).toBe("run-overflow");
    expect(terminalArgs.error).toContain("queue full");

    releaseBlockedDrive?.();
    for (let i = 0; i < 20; i++) {
      releaseBlockedDrive?.();
      await Bun.sleep(5);
    }
  }, 20_000);
});
