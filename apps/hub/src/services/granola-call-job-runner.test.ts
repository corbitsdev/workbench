import { describe, expect, test } from "bun:test";
import {
  createGranolaCallJobRunner,
  buildGranolaCallTriggerPayload,
} from "./granola-call-job-runner";
import type { GranolaCallJobQueue } from "./granola-call-job-queue";
import type { StartRunInput, StartRunResult } from "./workflow-run-starter";
import type { GranolaCallJobRow } from "../db/schema";

function makeJob(
  overrides: Partial<GranolaCallJobRow> = {},
): GranolaCallJobRow {
  return {
    id: "job-1",
    tenantId: "ten-1",
    noteId: "note-1",
    status: "processing",
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    leaseOwner: null,
    leaseUntil: null,
    activeRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeQueue(jobs: GranolaCallJobRow[]): {
  queue: GranolaCallJobQueue;
  completed: string[];
  failed: { jobId: string; error: string }[];
  activeRunIds: string[];
} {
  const completed: string[] = [];
  const failed: { jobId: string; error: string }[] = [];
  const activeRunIds: string[] = [];
  const pending = [...jobs];
  const queue: GranolaCallJobQueue = {
    enqueue: async () => {},
    claimDue: async (limit) => pending.splice(0, Math.max(0, limit)),
    complete: async (jobId) => {
      completed.push(jobId);
    },
    fail: async (jobId, _workerId, error) => {
      failed.push({ jobId, error });
    },
    heartbeat: async () => true,
    setActiveRunId: async (_jobId, _workerId, runId) => {
      activeRunIds.push(runId);
      return true;
    },
  };
  return { queue, completed, failed, activeRunIds };
}

describe("granola call job runner", () => {
  test("buildGranolaCallTriggerPayload includes tenantDomain when non-empty", () => {
    expect(
      buildGranolaCallTriggerPayload(
        { noteId: "n-1", tenantId: "t-1" },
        "acme.com",
      ),
    ).toEqual({ noteId: "n-1", tenantDomain: "acme.com" });
    expect(
      buildGranolaCallTriggerPayload({ noteId: "n-1", tenantId: "t-1" }, "  "),
    ).toEqual({ noteId: "n-1" });
    expect(
      buildGranolaCallTriggerPayload({ noteId: "n-1", tenantId: "t-1" }),
    ).toEqual({ noteId: "n-1" });
  });

  test("startRun success + completed → queue.complete + setActiveRunId", async () => {
    const job = makeJob();
    const { queue, completed, failed, activeRunIds } = fakeQueue([job]);
    const startRunCalls: StartRunInput[] = [];
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async (args) => {
        startRunCalls.push(args);
        return { ok: true, deploymentId: "dep-1", runId: "run-1" };
      },
      waitForRun: async () => "completed",
    });

    await runner.runOnce();

    expect(startRunCalls).toEqual([
      {
        kind: "granola-call",
        tenantId: "ten-1",
        input: { noteId: "note-1" },
        source: "scheduler",
      },
    ]);
    expect(activeRunIds).toEqual(["run-1"]);
    expect(completed).toEqual(["job-1"]);
    expect(failed).toEqual([]);
  });

  test("startRun fail → queue.fail", async () => {
    const job = makeJob({ attempts: 1 });
    const { queue, completed, failed } = fakeQueue([job]);
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async (): Promise<StartRunResult> => ({
        ok: false,
        reason: "not_found",
        message: "no granola-call deployment",
      }),
      waitForRun: async () => {
        throw new Error("waitForRun should not be called");
      },
    });

    await runner.runOnce();

    expect(completed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.jobId).toBe("job-1");
    expect(failed[0]?.error).toContain("not_found");
    expect(failed[0]?.error).toContain("no granola-call deployment");
  });

  test("run failed → queue.fail", async () => {
    const job = makeJob({ attempts: 0 });
    const { queue, completed, failed } = fakeQueue([job]);
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async () => ({
        ok: true,
        deploymentId: "dep-1",
        runId: "run-fail",
      }),
      waitForRun: async () => "failed",
    });

    await runner.runOnce();

    expect(completed).toEqual([]);
    expect(failed).toEqual([
      {
        jobId: "job-1",
        error: "workflow run run-fail ended with status failed",
      },
    ]);
  });

  test("runOnce with no due jobs does not call startRun", async () => {
    const { queue, completed, failed } = fakeQueue([]);
    let startRunCalled = false;
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async () => {
        startRunCalled = true;
        return { ok: true, deploymentId: "dep-1", runId: "run-1" };
      },
    });

    await runner.runOnce();

    expect(startRunCalled).toBe(false);
    expect(completed).toEqual([]);
    expect(failed).toEqual([]);
  });

  test("reclaim with activeRunId running attaches — does not start second run", async () => {
    const job = makeJob({ activeRunId: "run-existing" });
    const { queue, completed, failed, activeRunIds } = fakeQueue([job]);
    let startRunCalled = false;
    const waited: string[] = [];
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async () => {
        startRunCalled = true;
        return { ok: true, deploymentId: "dep-1", runId: "run-new" };
      },
      peekRunStatus: async (runId) => {
        expect(runId).toBe("run-existing");
        return "running";
      },
      waitForRun: async (runId) => {
        waited.push(runId);
        return "completed";
      },
    });

    await runner.runOnce();

    expect(startRunCalled).toBe(false);
    expect(waited).toEqual(["run-existing"]);
    expect(activeRunIds).toEqual([]);
    expect(completed).toEqual(["job-1"]);
    expect(failed).toEqual([]);
  });

  test("reclaim with activeRunId already completed → complete without startRun", async () => {
    const job = makeJob({ activeRunId: "run-done" });
    const { queue, completed, failed } = fakeQueue([job]);
    let startRunCalled = false;
    let waitCalled = false;
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async () => {
        startRunCalled = true;
        return { ok: true, deploymentId: "dep-1", runId: "run-new" };
      },
      peekRunStatus: async () => "completed",
      waitForRun: async () => {
        waitCalled = true;
        return "completed";
      },
    });

    await runner.runOnce();

    expect(startRunCalled).toBe(false);
    expect(waitCalled).toBe(false);
    expect(completed).toEqual(["job-1"]);
    expect(failed).toEqual([]);
  });

  test("prior failed activeRunId → startRun new run (retry re-executes graph)", async () => {
    const job = makeJob({ activeRunId: "run-failed", attempts: 1 });
    const { queue, completed, failed, activeRunIds } = fakeQueue([job]);
    const startRunCalls: StartRunInput[] = [];
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      startRun: async (args) => {
        startRunCalls.push(args);
        return { ok: true, deploymentId: "dep-1", runId: "run-retry" };
      },
      peekRunStatus: async (runId) => {
        expect(runId).toBe("run-failed");
        return "failed";
      },
      waitForRun: async (runId) => {
        expect(runId).toBe("run-retry");
        return "completed";
      },
    });

    await runner.runOnce();

    expect(startRunCalls).toHaveLength(1);
    expect(activeRunIds).toEqual(["run-retry"]);
    expect(completed).toEqual(["job-1"]);
    expect(failed).toEqual([]);
  });
});
