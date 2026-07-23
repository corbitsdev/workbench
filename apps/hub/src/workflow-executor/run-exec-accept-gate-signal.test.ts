import { describe, expect, mock, test } from "bun:test";
import type { HubDb } from "../db";
import type { RunState } from "./run-store";

// acceptGateSignal (the deployment-scoped POST /workflow-runs/:deploymentId/signal
// path) is a SECOND, independent write to the durable pending-signal rail,
// alongside resumeWorkflowRun's /resume-route path. Both must validate AND
// normalize a registered kind/signal's payload the same way — this file proves
// acceptGateSignal does, specifically for attio-task-agent's sync-approval
// gate's TRANSITIONAL legacy-payload compatibility (CL-4232).

const persisted: { runId: string; payload: unknown }[] = [];
const dispatched: { runId: string; signalName: string; payload: unknown }[] =
  [];

mock.module("./run-store", () => ({
  loadRunRecord: async (_db: unknown, runId: string): Promise<RunState> => ({
    runId,
    kind: "attio-task-agent",
    tenantId: "tn-1",
    principalId: "prn-1",
    status: "awaiting",
    deploymentId: "ses_dep1",
  }),
  setPendingSignal: async (
    _db: unknown,
    runId: string,
    args: { payload: unknown },
  ) => {
    // Records the PERSISTED payload distinctly from the dispatched one, so a
    // future edit that splits the two call sites can't hide behind a shared
    // variable the way the reviewed gap did.
    persisted.push({ runId, payload: args.payload });
  },
  // acceptGateSignal itself uses only loadRunRecord + setPendingSignal, but
  // run-exec.ts imports the rest of the module's surface too — stub the
  // unused exports so the mock module shape matches (unreached by this test).
  insertRunRecord: async () => {
    throw new Error("not used by acceptGateSignal");
  },
  failRunIfStillProvisioning: async () => false,
  setRunDeployment: async () => {},
}));

mock.module("./run-awaiting-signals", () => ({
  getAwaitingSignalNames: async (): Promise<Set<string>> =>
    new Set(["sync-approval"]),
}));

const { acceptGateSignal } = await import("./run-exec");

function baseDeps() {
  return {
    db: {} as HubDb,
    repoStore: {} as never,
    sidecarRouter: {
      sendSignalDeliver: (args: {
        runId: string;
        signalName: string;
        payload: unknown;
      }) => {
        dispatched.push({
          runId: args.runId,
          signalName: args.signalName,
          payload: args.payload,
        });
      },
    } as never,
    deploymentDomain: "wf.localhost",
    ensureDeploymentRoutable: async () => ({ reestablished: false }),
    isSidecarConnected: () => true,
  };
}

describe("acceptGateSignal (deployment-scoped signal route)", () => {
  test("normalizes a legacy attio sync-approval payload (note, no idempotencyKey) before persisting AND dispatching", async () => {
    persisted.length = 0;
    dispatched.length = 0;

    const result = await acceptGateSignal(baseDeps(), {
      deploymentId: "ses_dep1",
      kind: "attio-task-agent",
      tenantId: "tn-1",
      creatorPrincipalId: "prn-deployer",
      runId: "run-1",
      signalName: "sync-approval",
      payload: {
        confirm: true,
        taskId: "task_1",
        parentObject: "companies",
        parentRecordId: "rec_1",
        note: "Pilot kicked off.",
      },
    });

    expect(result.ok).toBe(true);

    const canonical = {
      confirm: true,
      taskId: "task_1",
      idempotencyKey: "task_1",
      parentObject: "companies",
      parentRecordId: "rec_1",
      content: "Pilot kicked off.",
    };
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.payload).toEqual(canonical);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toEqual(canonical);
  });

  test("passes a canonical attio sync-approval payload through unchanged", async () => {
    persisted.length = 0;
    dispatched.length = 0;

    const canonical = {
      confirm: true,
      taskId: "task_1",
      idempotencyKey: "task_1",
      parentObject: "companies",
      parentRecordId: "rec_1",
      content: "Pilot kicked off.",
    };
    const result = await acceptGateSignal(baseDeps(), {
      deploymentId: "ses_dep1",
      kind: "attio-task-agent",
      tenantId: "tn-1",
      creatorPrincipalId: "prn-deployer",
      runId: "run-1",
      signalName: "sync-approval",
      payload: canonical,
    });

    expect(result.ok).toBe(true);
    expect(persisted[0]?.payload).toEqual(canonical);
    expect(dispatched[0]?.payload).toEqual(canonical);
  });

  test("rejects a malformed attio sync-approval payload (400) without persisting or dispatching", async () => {
    persisted.length = 0;
    dispatched.length = 0;

    const result = await acceptGateSignal(baseDeps(), {
      deploymentId: "ses_dep1",
      kind: "attio-task-agent",
      tenantId: "tn-1",
      creatorPrincipalId: "prn-deployer",
      runId: "run-1",
      signalName: "sync-approval",
      payload: { confirm: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(persisted).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });
});
