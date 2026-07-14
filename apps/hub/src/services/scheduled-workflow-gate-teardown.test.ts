import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TurnFinalized } from "@workbench/event-collector";

mock.module("../config", () => ({
  getConfig: () => ({ featureGrantCacheTtlMs: 30_000 }),
}));
import type { HubDb } from "../db";
import { resetFeatureGrantCache } from "../lib/feature-grants";

const launchMock = mock(
  async (
    _db: unknown,
    _sessionService: unknown,
    _grantStore: unknown,
    _eventCollectors: unknown,
    opts: { instanceId: string },
  ) => ({
    address: `${opts.instanceId}@tenant.example`,
    sessionId: "ses-gate-1",
  }),
);
mock.module("./agent-provisioning", () => ({
  launchAgentSession: launchMock,
}));

const MYRA_DEF = {
  id: "agt_myra",
  tenantId: "ten-1",
  name: "Myra",
  modelConfig: { defaultModel: "deepseek-v4-flash" },
};
const teardownMock = mock(async () => undefined);
mock.module("./myra-threads", () => ({
  resolveMyraDefinition: mock(async () => MYRA_DEF),
  teardownThreadRows: teardownMock,
}));

let pendingGates: Array<{ signalName: string }> = [{ signalName: "confirm" }];
mock.module("../workflow-executor/pending-gate-info", () => ({
  describePendingGates: mock(async () => pendingGates),
}));

mock.module("../workflow-executor/run-store", () => ({
  loadRunRecord: mock(async () => ({ triggerSource: "scheduler" })),
  setRunStatus: mock(async () => undefined),
  setPendingSignal: mock(async () => undefined),
  loadDeploymentMeta: mock(async () => null),
}));

mock.module("../workflow-executor/run-terminal-mail", () => ({
  deliverRunTerminalMail: mock(async () => undefined),
}));

mock.module("../lib/workflow-catalog", () => ({
  loadWorkflowGateInfos: mock(
    async () =>
      new Map([
        [
          "allowed-multi",
          {
            requiresIntake: true,
            humanGateCount: 2,
            allowsScheduledPostIntakeDrive: true,
          },
        ],
      ]),
  ),
}));

const { createScheduledWorkflowGateAgent } = await import(
  "./scheduled-workflow-gate-agent"
);

function makeDb(): HubDb {
  const tx = {
    insert: mock(() => ({
      values: mock(async () => undefined),
    })),
  };
  return {
    query: {
      tenant: {
        findFirst: mock(async () => ({
          id: "ten-1",
          domain: "tenant.example",
        })),
      },
    },
    transaction: mock(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  } as unknown as HubDb;
}

function makeSessionService() {
  const sendUserMessage = mock(async () => new Uint8Array());
  const endSession = mock(async () => undefined);
  return {
    service: { sendUserMessage, endSession } as never,
    sendUserMessage,
    endSession,
  };
}

function completedTurn(text: string): TurnFinalized {
  return {
    status: "completed",
    text,
    toolCalls: [],
    usage: undefined,
  } as TurnFinalized;
}

const REPO = {} as never;
const DUMMY = {} as never;

beforeEach(() => {
  teardownMock.mockClear();
  launchMock.mockClear();
  pendingGates = [{ signalName: "confirm" }];
  resetFeatureGrantCache();
});

describe("scheduled gate Myra session teardown", () => {
  it("calls endSession and teardownThreadRows after a successful drive turn", async () => {
    const db = makeDb();
    const session = makeSessionService();
    const agent = createScheduledWorkflowGateAgent({
      db,
      sessionService: session.service,
      grantStore: DUMMY,
      eventCollectors: DUMMY,
      cryptoProvider: DUMMY,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      turnTimeoutMs: 5_000,
      now: () => 1_700_000_000_000,
    });

    agent.maybeEnqueue({
      runId: "run-1",
      kind: "allowed-multi",
      tenantId: "ten-1",
      principalId: "pri-1",
      deploymentId: "dep-1",
      repoStore: REPO,
    });

    for (let i = 0; i < 200; i++) {
      if (session.sendUserMessage.mock.calls.length > 0) break;
      await Bun.sleep(10);
    }

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    pendingGates = [];
    agent.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await agent.waitForDrain();

    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("does not teardown when endSession fails (boot sweep retries)", async () => {
    const db = makeDb();
    const session = makeSessionService();
    session.endSession.mockImplementation(async () => {
      throw new Error("sidecar unreachable");
    });
    const agent = createScheduledWorkflowGateAgent({
      db,
      sessionService: session.service,
      grantStore: DUMMY,
      eventCollectors: DUMMY,
      cryptoProvider: DUMMY,
      deploymentDomain: "tenant.example",
      schedulerFeatureDefaultEnabled: true,
      turnTimeoutMs: 5_000,
      now: () => 1_700_000_000_000,
    });

    agent.maybeEnqueue({
      runId: "run-1",
      kind: "allowed-multi",
      tenantId: "ten-1",
      principalId: "pri-1",
      deploymentId: "dep-1",
      repoStore: REPO,
    });

    for (let i = 0; i < 200; i++) {
      if (session.sendUserMessage.mock.calls.length > 0) break;
      await Bun.sleep(10);
    }

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    pendingGates = [];
    agent.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await agent.waitForDrain();

    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
  });
});