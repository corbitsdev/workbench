import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import type { WorkflowRunStarter } from "./workflow-run-starter";

// CL-4548: the scheduler's `startWorkflowRun` fire handler is extracted to its
// own module specifically so it can be exercised directly — before this,
// `scheduled-workflow-gate-success.integration.test.ts` hand-rolled its own
// `startWorkflowRun` stub inside `createScheduler({...})` and never touched
// the real index.ts closure, so a wrong `fire.kind`/`result.runId` wiring bug
// there would have been invisible to the suite.

const deliverCalls: {
  runId: string;
  kind: string;
  triggerPayload: Record<string, unknown>;
}[] = [];
let deliverResult: boolean | Promise<never> = true;

mock.module("../lib/scheduled-intake", () => ({
  deliverStartIntakeSignal: (
    _db: unknown,
    args: {
      runId: string;
      kind: string;
      triggerPayload: Record<string, unknown>;
    },
  ) => {
    deliverCalls.push(args);
    return typeof deliverResult === "boolean"
      ? Promise.resolve(deliverResult)
      : deliverResult;
  },
}));

const { createSchedulerStartWorkflowRun } = await import(
  "./scheduler-run-starter"
);

const FIRE = {
  kind: "last30days-research",
  tenantId: "tenant-1",
  creatorPrincipalId: "prn-owner",
  triggerPayload: { topic: "AI agents", focus: "GTM" },
  nowMs: Date.now(),
  lastFiredWindowIndex: 19000,
  intervalMinutes: 1440,
  anchorMinuteUtc: 780,
};

function makeRunStarter(
  startRun: WorkflowRunStarter["startRun"],
): WorkflowRunStarter {
  return { startRun };
}

describe("createSchedulerStartWorkflowRun", () => {
  it("starts the run with the fire's real kind/tenant/window, then delivers the queued intake keyed on the FRESH runId (not a stale one)", async () => {
    deliverCalls.length = 0;
    deliverResult = true;
    const startArgs: unknown[] = [];
    const runStarter = makeRunStarter(async (args) => {
      startArgs.push(args);
      return { ok: true, deploymentId: "dep-fresh", runId: "run-fresh-123" };
    });

    const startWorkflowRun = createSchedulerStartWorkflowRun({
      db: {} as HubDb,
      runStarter,
    });
    const result = await startWorkflowRun(FIRE);

    expect(startArgs).toEqual([
      {
        kind: "last30days-research",
        tenantId: "tenant-1",
        input: { topic: "AI agents", focus: "GTM" },
        creatorPrincipalId: "prn-owner",
        source: "scheduler",
        heartbeatFire: { lastFiredDayUtc: 19000, anchorMinuteUtc: 780 },
      },
    ]);
    expect(result).toEqual({
      deploymentId: "dep-fresh",
      accepted: true,
      runId: "run-fresh-123",
    });
    // The runId threaded to deliverStartIntakeSignal must be the ONE just
    // minted by this start (result.runId), not the fire's own identity — a
    // schedule row carries no runId of its own.
    expect(deliverCalls).toEqual([
      {
        runId: "run-fresh-123",
        kind: "last30days-research",
        triggerPayload: { topic: "AI agents", focus: "GTM" },
      },
    ]);
  });

  it("throws (never delivers intake) when the run fails to start", async () => {
    deliverCalls.length = 0;
    const runStarter = makeRunStarter(async () => ({
      ok: false,
      status: 400,
      reason: "invalid_input",
      message: "topic is required",
    }));

    const startWorkflowRun = createSchedulerStartWorkflowRun({
      db: {} as HubDb,
      runStarter,
    });

    await expect(startWorkflowRun(FIRE)).rejects.toThrow(
      "run-start invalid_input: topic is required",
    );
    expect(deliverCalls).toEqual([]);
  });

  it("does not let an intake-delivery failure break the scheduler tick (fire-and-forget, caught internally)", async () => {
    deliverCalls.length = 0;
    deliverResult = Promise.reject(new Error("delivery boom"));
    const runStarter = makeRunStarter(async () => ({
      ok: true,
      deploymentId: "dep-2",
      runId: "run-2",
    }));

    const startWorkflowRun = createSchedulerStartWorkflowRun({
      db: {} as HubDb,
      runStarter,
    });

    const result = await startWorkflowRun(FIRE);
    expect(result.runId).toBe("run-2");
  });
});
