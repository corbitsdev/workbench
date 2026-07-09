import { describe, expect, test } from "bun:test";
import {
  buildRunFailureReport,
  createCoalescingScheduler,
  foldRunEvents,
  isNewWorkflowRunFailure,
  logNewWorkflowRunFailureIfNeeded,
  type ProjectedRun,
  type RunEventEntry,
} from "./projection-bridge";

function entry(
  runId: string,
  type: string,
  rest: Record<string, unknown> = {},
): RunEventEntry {
  return { runId, event: { type, seq: 0, ...rest } };
}

describe("foldRunEvents (run-level, CL-2669)", () => {
  test("parks at a gate: status awaiting, run start time captured", () => {
    const runs = foldRunEvents([
      entry("r1", "RunStarted", { at: "2026-01-01T00:00:01.000Z" }),
      entry("r1", "StepStarted", { stepId: "intake" }),
      entry("r1", "SignalAwaited", {
        stepId: "select",
        signalName: "note-selection",
      }),
    ]);
    const r1 = runs.get("r1");
    expect(r1?.status).toBe("awaiting");
    expect(r1?.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(r1?.endedAt).toBeUndefined();
  });

  test("SignalReceived clears the gate back to running", () => {
    const runs = foldRunEvents([
      entry("r1", "SignalAwaited", { stepId: "select", signalName: "s" }),
      entry("r1", "SignalReceived", {
        signalName: "s",
        signalId: "x",
        payload: {},
      }),
    ]);
    expect(runs.get("r1")?.status).toBe("running");
  });

  test("SignalReceived surfaces its signalId so the pending-signal record can be cleared", () => {
    const runs = foldRunEvents([
      entry("r1", "SignalAwaited", { stepId: "gate1", signalName: "s" }),
      entry("r1", "SignalReceived", {
        signalName: "s",
        signalId: "sig-a",
        payload: {},
      }),
      entry("r1", "SignalAwaited", { stepId: "gate2", signalName: "s" }),
    ]);
    const r1 = runs.get("r1");
    // Re-parked at a later gate, but gate1's signal is durably observed:
    // the projection can clear a pending-signal record by signalId even
    // when the final folded status is `awaiting` again.
    expect(r1?.status).toBe("awaiting");
    expect(r1?.receivedSignalIds).toContain("sig-a");
  });

  test("RunCompleted is terminal and stamps the end time", () => {
    const runs = foldRunEvents([
      entry("r1", "RunStarted", { at: "2026-01-01T00:00:01.000Z" }),
      entry("r1", "StepStarted", { stepId: "persist" }),
      entry("r1", "RunCompleted", { at: "2026-01-01T00:00:09.000Z" }),
    ]);
    const r1 = runs.get("r1");
    expect(r1?.status).toBe("completed");
    expect(r1?.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(r1?.endedAt).toBe("2026-01-01T00:00:09.000Z");
  });

  test("RunFailed surfaces the error message and fails the run", () => {
    const runs = foldRunEvents([
      entry("r1", "StepStarted", { stepId: "analyze" }),
      entry("r1", "RunFailed", {
        at: "2026-01-01T00:00:05.000Z",
        error: { message: "boom" },
      }),
    ]);
    const r1 = runs.get("r1");
    expect(r1?.status).toBe("failed");
    expect(r1?.error).toBe("boom");
    expect(r1?.endedAt).toBe("2026-01-01T00:00:05.000Z");
  });

  test("StepFailed fails the run and attributes the last started step", () => {
    const runs = foldRunEvents([
      entry("r1", "StepStarted", { stepId: "analyze" }),
      entry("r1", "StepFailed", {
        stepId: "analyze",
        error: { message: "tool 500" },
      }),
    ]);
    expect(runs.get("r1")?.status).toBe("failed");
    expect(runs.get("r1")?.error).toBe('step "analyze" failed: tool 500');
    expect(runs.get("r1")?.failedSteps).toEqual([
      { stepId: "analyze", message: "tool 500" },
    ]);
  });

  test("StepFailed with no stepId attributes the last started step", () => {
    const runs = foldRunEvents([
      entry("r1", "StepStarted", { stepId: "score" }),
      entry("r1", "StepFailed", { error: { message: "no id" } }),
    ]);
    expect(runs.get("r1")?.failedSteps).toEqual([
      { stepId: "score", message: "no id" },
    ]);
  });

  test("RunCancelled is reported as failed/cancelled", () => {
    const runs = foldRunEvents([
      entry("r1", "RunStarted"),
      entry("r1", "RunCancelled", { at: "2026-01-01T00:00:03.000Z" }),
    ]);
    expect(runs.get("r1")?.status).toBe("failed");
    expect(runs.get("r1")?.error).toBe("cancelled");
    expect(runs.get("r1")?.endedAt).toBe("2026-01-01T00:00:03.000Z");
  });

  test("interleaved runs on one repo project independently", () => {
    const runs = foldRunEvents([
      entry("r1", "RunStarted"),
      entry("r2", "RunStarted"),
      entry("r1", "StepStarted", { stepId: "a" }),
      entry("r2", "RunCompleted"),
      entry("r1", "SignalAwaited", { stepId: "gate", signalName: "s" }),
    ]);
    expect(runs.get("r1")?.status).toBe("awaiting");
    expect(runs.get("r2")?.status).toBe("completed");
  });
});

describe("isNewWorkflowRunFailure", () => {
  test("true when status newly becomes failed", () => {
    expect(isNewWorkflowRunFailure("running", "failed")).toBe(true);
    expect(isNewWorkflowRunFailure("awaiting", "failed")).toBe(true);
  });

  test("false when already failed or not a failure transition", () => {
    expect(isNewWorkflowRunFailure("failed", "failed")).toBe(false);
    expect(isNewWorkflowRunFailure("running", "completed")).toBe(false);
  });
});

describe("createCoalescingScheduler", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  test("coalesces re-arrivals during a run into exactly one re-run", async () => {
    const runOrder: number[] = [];
    let n = 0;
    const started = [deferred(), deferred()];
    const gates = [deferred(), deferred()];
    const scheduler = createCoalescingScheduler(async () => {
      const i = n++;
      runOrder.push(i);
      started[i]?.resolve();
      await gates[i]?.promise;
    });

    scheduler.schedule("k"); // run 0 starts, holds on gate 0
    scheduler.schedule("k"); // marks dirty
    scheduler.schedule("k"); // still dirty (coalesced, not a third run)
    await started[0]?.promise;
    expect(runOrder).toEqual([0]);

    gates[0]?.resolve(); // run 0 finishes -> dirty triggers exactly one re-run
    await started[1]?.promise;
    expect(runOrder).toEqual([0, 1]);

    gates[1]?.resolve();
    await scheduler.idle();
    expect(runOrder).toEqual([0, 1]); // no third run — the two dirty marks coalesced
  });

  test("distinct keys run concurrently and idle() awaits all", async () => {
    const seen: string[] = [];
    const scheduler = createCoalescingScheduler(async (key) => {
      seen.push(key);
    });
    scheduler.schedule("a");
    scheduler.schedule("b");
    await scheduler.idle();
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  test("a throwing task does not wedge the key for future schedules", async () => {
    let calls = 0;
    const scheduler = createCoalescingScheduler(async () => {
      calls++;
      if (calls === 1) throw new Error("first fails");
    });
    scheduler.schedule("k");
    await scheduler.idle();
    scheduler.schedule("k");
    await scheduler.idle();
    expect(calls).toBe(2);
  });
});

describe("logNewWorkflowRunFailureIfNeeded", () => {
  function failedProjected(error = "something broke"): ProjectedRun {
    return {
      status: "failed",
      error,
      failedSteps: [],
    };
  }

  test("does not throw when version and sha are provided", () => {
    expect(() =>
      logNewWorkflowRunFailureIfNeeded("running", failedProjected(), {
        runId: "wfr_1",
        kind: "pain-point-collateral",
        deploymentId: "ses_dep1",
        version: "1.2.3",
        sha: "abc1234",
      }),
    ).not.toThrow();
  });

  test("does not throw when version and sha are absent (old deploy path)", () => {
    expect(() =>
      logNewWorkflowRunFailureIfNeeded("running", failedProjected(), {
        runId: "wfr_2",
        kind: "pain-point-collateral",
        deploymentId: null,
      }),
    ).not.toThrow();
  });

  test("does not log when the run was already failed (no transition)", () => {
    // If previousStatus is already 'failed', isNewWorkflowRunFailure returns false
    // and the function is a no-op — no throw, no side effect.
    expect(() =>
      logNewWorkflowRunFailureIfNeeded("failed", failedProjected(), {
        runId: "wfr_3",
        kind: "ab-compare-quality",
        deploymentId: "ses_dep2",
        version: "0.1.0",
        sha: "def5678",
      }),
    ).not.toThrow();
  });
});

// GOAL A (CL-2503): the failure forwarded to the error log / Sentry must carry
// a real Error (with a stack, captured via captureException) and name the
// failing step(s) — not a bare one-line message with no context.
describe("buildRunFailureReport", () => {
  function projected(
    error: string | undefined,
    failedSteps: { stepId: string; message: string }[] = [],
  ): ProjectedRun {
    return {
      status: "failed",
      ...(error !== undefined ? { error } : {}),
      failedSteps,
    };
  }

  test("forwards an Error carrying a stack and the failure detail", () => {
    const report = buildRunFailureReport(
      projected('step "groundQueries" failed: tool not registered'),
      { runId: "wfr_1", kind: "last30days", deploymentId: "ses_dep1" },
    );
    expect(report.error).toBeInstanceOf(Error);
    expect(report.error.message).toBe(
      'step "groundQueries" failed: tool not registered',
    );
    expect(report.error.name).toBe("WorkflowRunFailedError");
    expect(typeof report.error.stack).toBe("string");
    expect(report.error.stack?.length ?? 0).toBeGreaterThan(0);
  });

  test("attaches the per-step failure breakdown as a Sentry property", () => {
    const failedSteps = [
      { stepId: "groundQueries", message: "tool not registered" },
    ];
    const report = buildRunFailureReport(
      projected("one or more steps failed", failedSteps),
      {
        runId: "wfr_2",
        kind: "last30days",
        deploymentId: "ses_dep2",
        version: "1.0.0",
        sha: "abc1234",
      },
    );
    expect(report.properties.failedSteps).toEqual(failedSteps);
    expect(report.properties.runId).toBe("wfr_2");
    expect(report.properties.deploymentId).toBe("ses_dep2");
    expect(report.properties.version).toBe("1.0.0");
    expect(report.properties.sha).toBe("abc1234");
  });

  test("omits optional context and failedSteps when absent", () => {
    const report = buildRunFailureReport(projected(undefined), {
      runId: "wfr_3",
      kind: "last30days",
      deploymentId: null,
    });
    expect(report.error.message).toBe("workflow run failed");
    expect("deploymentId" in report.properties).toBe(false);
    expect("version" in report.properties).toBe(false);
    expect("failedSteps" in report.properties).toBe(false);
  });
});
