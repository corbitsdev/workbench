import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import type { ResumeWorkflowRunDeps } from "./run-exec";

// The deployment-scoped signal route persists a DURABLE pending-signal record
// before dispatch. That rail must be as guarded as the records-route resume:
// the run must belong to the authorized deployment and must actually be
// parked on an open gate for the named signal — otherwise any authenticated
// caller could stamp a pending signal on ANY run globally, and the reconciler
// would wake that foreign run's deployment and re-deliver the
// attacker-controlled payload every pass forever (a never-matching signal
// never clears).

const runsById = new Map<
  string,
  {
    runId: string;
    kind: string;
    tenantId: string;
    principalId: string;
    status: "running" | "awaiting" | "completed" | "failed";
    deploymentId?: string;
  }
>();
const persisted: { runId: string; signalName: string }[] = [];

mock.module("./run-store", () => ({
  // run-exec.ts imports these too; the module replacement must cover them.
  insertRunRecord: async () => {
    throw new Error("not used by acceptGateSignal tests");
  },
  failRunIfStillProvisioning: async () => false,
  setRunDeployment: async () => {},
  loadRunRecord: async (_db: unknown, runId: string) =>
    runsById.get(runId) ?? null,
  setPendingSignal: async (
    _db: unknown,
    runId: string,
    signal: { signalName: string },
  ) => {
    persisted.push({ runId, signalName: signal.signalName });
  },
}));

// The live-gate read; per-test canned open-signal set (null = unreadable log).
let cannedAwaitingSignals: string[] | null = [];
mock.module("./run-awaiting-signals", () => ({
  getAwaitingSignalNames: async () => {
    if (cannedAwaitingSignals === null) throw new Error("log unreadable");
    return new Set(cannedAwaitingSignals);
  },
}));

// CL-3301: an accepted gate signal resolves the gate's "needs you" mailbox
// item. Spy at the module boundary so the test asserts run-exec calls it with
// the accepted run + signal, and only on the accept path.
const markedRead: { runId: string; signalName: string }[] = [];
mock.module("../lib/principal-mailbox", () => ({
  markGateMailboxItemRead: async (
    _db: unknown,
    runId: string,
    signalName: string,
  ) => {
    markedRead.push({ runId, signalName });
  },
}));

const { acceptGateSignal } = await import("./run-exec");

function makeDeps() {
  const ensured: string[] = [];
  const sent: { runId: string; signalName: string; payload: unknown }[] = [];
  const deps = {
    db: {} as HubDb,
    repoStore: {} as ResumeWorkflowRunDeps["repoStore"],
    deploymentDomain: "wf.localhost",
    ensureDeploymentRoutable: async (args: { deploymentId: string }) => {
      ensured.push(args.deploymentId);
      return { reestablished: false };
    },
    sidecarRouter: {
      sendSignalDeliver: (args: {
        runId: string;
        signalName: string;
        payload: unknown;
      }) => {
        sent.push({
          runId: args.runId,
          signalName: args.signalName,
          payload: args.payload,
        });
      },
    },
  } as unknown as ResumeWorkflowRunDeps;
  return { deps, ensured, sent };
}

function seedRun(runId: string, deploymentId: string): void {
  runsById.set(runId, {
    runId,
    kind: "deck",
    tenantId: "t1",
    principalId: "prn-1",
    status: "awaiting",
    deploymentId,
  });
}

function reset(): void {
  runsById.clear();
  persisted.length = 0;
  markedRead.length = 0;
  cannedAwaitingSignals = [];
}

describe("acceptGateSignal — the durable pending-signal rail is guarded", () => {
  it("rejects a runId that belongs to a DIFFERENT deployment and persists nothing", async () => {
    reset();
    seedRun("run_foreign", "ses_other_deployment");
    cannedAwaitingSignals = ["approval"];
    const { deps, sent } = makeDeps();

    const result = await acceptGateSignal(deps, {
      deploymentId: "ses_authorized",
      kind: "deck",
      tenantId: "t1",
      creatorPrincipalId: "prn-deployer",
      runId: "run_foreign",
      signalName: "approval",
      payload: { hostile: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(persisted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rejects a signal for a run with NO open gate for that name and persists nothing", async () => {
    reset();
    seedRun("run_parked", "ses_dep");
    cannedAwaitingSignals = ["some-other-gate"];
    const { deps, sent } = makeDeps();

    const result = await acceptGateSignal(deps, {
      deploymentId: "ses_dep",
      kind: "deck",
      tenantId: "t1",
      creatorPrincipalId: "prn-deployer",
      runId: "run_parked",
      signalName: "approval",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    expect(persisted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rejects an unknown runId with 404 and persists nothing", async () => {
    reset();
    const { deps, sent } = makeDeps();

    const result = await acceptGateSignal(deps, {
      deploymentId: "ses_dep",
      kind: "deck",
      tenantId: "t1",
      creatorPrincipalId: "prn-deployer",
      runId: "run_missing",
      signalName: "approval",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(persisted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("accepts a signal for the deployment's own run parked on the named gate: persists durably, then delivers", async () => {
    reset();
    seedRun("run_ok", "ses_dep");
    cannedAwaitingSignals = ["approval"];
    const { deps, ensured, sent } = makeDeps();

    const result = await acceptGateSignal(deps, {
      deploymentId: "ses_dep",
      kind: "deck",
      tenantId: "t1",
      creatorPrincipalId: "prn-deployer",
      runId: "run_ok",
      signalName: "approval",
      payload: { approved: true },
    });

    expect(result.ok).toBe(true);
    expect(persisted).toEqual([{ runId: "run_ok", signalName: "approval" }]);
    expect(ensured).toEqual(["ses_dep"]);
    expect(sent).toEqual([
      { runId: "run_ok", signalName: "approval", payload: { approved: true } },
    ]);
    // The gate's "needs you" mailbox item is resolved on accept (CL-3301).
    expect(markedRead).toEqual([{ runId: "run_ok", signalName: "approval" }]);
  });

  it("does not touch the mailbox when the accept is rejected", async () => {
    reset();
    seedRun("run_parked", "ses_dep");
    cannedAwaitingSignals = ["some-other-gate"];
    const { deps } = makeDeps();

    await acceptGateSignal(deps, {
      deploymentId: "ses_dep",
      kind: "deck",
      tenantId: "t1",
      creatorPrincipalId: "prn-deployer",
      runId: "run_parked",
      signalName: "approval",
      payload: {},
    });

    expect(markedRead).toEqual([]);
  });
});
