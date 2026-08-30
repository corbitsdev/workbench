// Scheduler poller: claim → fire, backoff on failure, dead-letter at max.
import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  backoffMsForFailure,
  createInMemoryRoutineStore,
  MAX_ROUTINE_FIRE_FAILURES,
  type RoutineLauncher,
} from "@corbits/routines";
import {
  createRoutineScheduler,
  DEFAULT_ROUTINE_SCHEDULER_POLL_INTERVAL_MS,
  tickRoutineScheduler,
} from "../src/routine-scheduler";

const CRON = { kind: "cron" as const, expression: "0 * * * *" };

function launcher(impl: RoutineLauncher["launchRoutineRun"]): RoutineLauncher {
  return { launchRoutineRun: impl };
}

describe("tickRoutineScheduler", () => {
  test("claims a due routine and launches it once", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "hourly",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: { x: 1 },
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    const at = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const launches: string[] = [];
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async (input) => {
          launches.push(input.definitionId);
          return { runId: "run_1" };
        }),
      },
      at,
    );
    expect(launches).toEqual(["def_1"]);
    const runs = await store.listRunsForRoutine("t1", routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggeredBy).toBe("schedule");
    expect(runs[0]?.runId).toBe("run_1");
  });

  test("threads deliveryWorkbenchRequired through to fireScheduledRoutine, firing a workbench-less routine when the port says one isn't needed", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "inbox-only task",
      definitionId: "def_inbox_only",
      trigger: CRON,
      scope: "bench",
      input: { agent: "wfd_agent", prompt: "Do it" },
      createdBy: "user_1",
    });
    const at = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const launches: string[] = [];
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async (input) => {
          launches.push(input.definitionId);
          return { runId: "run_task_1" };
        }),
        deliveryWorkbenchRequired: async () => false,
      },
      at,
    );
    expect(launches).toEqual(["def_inbox_only"]);
    const runs = await store.listRunsForRoutine("t1", routine.id);
    expect(runs).toHaveLength(1);
  });

  test("a scheduled fire launches with no delivery thread — the run posts to the workbench root", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "hourly digest",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    const at = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    let seenInput:
      Parameters<RoutineLauncher["launchRoutineRun"]>[0] | undefined;
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async (input) => {
          seenInput = input;
          return { runId: "run_1" };
        }),
      },
      at,
    );
    expect(seenInput).not.toHaveProperty("deliveryThreadId");
  });

  test("a launch failure backs off and records schedule-failed", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "flaky",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    const at = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async () => {
          throw new Error("launch exploded");
        }),
      },
      at,
    );

    const after = await store.getRoutine("t1", routine.id);
    if (!after) throw new Error("expected routine after failure");
    expect(after.consecutiveFailures).toBe(1);
    const afterNext = after.nextFireAt;
    if (!afterNext) throw new Error("expected nextFireAt after failure");
    expect(afterNext.getTime()).toBe(at.getTime() + backoffMsForFailure(1));
    // Not immediately due again at the same instant.
    expect(await store.listDueRoutines(at)).toEqual([]);

    const runs = await store.listRunsForRoutine("t1", routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggeredBy).toBe("schedule-failed");
    expect(runs[0]?.error).toContain("launch exploded");
  });

  test("after backoff elapses the routine is claimed again", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "retry",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    const at = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async () => {
          throw new Error("first");
        }),
      },
      at,
    );
    const afterFail = await store.getRoutine("t1", routine.id);
    if (!afterFail) throw new Error("expected routine after failure");
    const retryAt = afterFail.nextFireAt;
    if (!retryAt) throw new Error("expected nextFireAt after failure");
    let launches = 0;
    await tickRoutineScheduler(
      {
        store,
        launcher: launcher(async () => {
          launches += 1;
          return { runId: "run_ok" };
        }),
      },
      retryAt,
    );
    expect(launches).toBe(1);
    const recovered = await store.getRoutine("t1", routine.id);
    if (!recovered) throw new Error("expected recovered routine");
    expect(recovered.consecutiveFailures).toBe(0);
  });

  test("after MAX failures the routine is dead-lettered and never claimed again", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "dead",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    let clock = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    for (let i = 0; i < MAX_ROUTINE_FIRE_FAILURES; i++) {
      const current = await store.getRoutine("t1", routine.id);
      if (!current) throw new Error("expected routine in loop");
      if (current.nextFireAt !== null) {
        clock = new Date(
          Math.max(clock.getTime(), current.nextFireAt.getTime()),
        );
      }
      await tickRoutineScheduler(
        {
          store,
          launcher: launcher(async () => {
            throw new Error(`fail ${i + 1}`);
          }),
        },
        clock,
      );
    }
    const final = await store.getRoutine("t1", routine.id);
    if (!final) throw new Error("expected routine after dead-letter");
    expect(final.deadLetteredAt).not.toBeNull();
    expect(final.consecutiveFailures).toBe(MAX_ROUTINE_FIRE_FAILURES);
    expect(
      await store.listDueRoutines(new Date(clock.getTime() + 1e12)),
    ).toEqual([]);
  });
});

// `createRoutineScheduler`'s own `setInterval` wrapper — the piece an
// e2e test cannot drive with fake timers because it lives in a spawned
// child process (see CL-7250). Proven here instead, entirely
// in-process with Bun's fake timers, so the real 30s production
// cadence and the injectable override are both covered in
// milliseconds rather than by waiting either one out for real.
describe("createRoutineScheduler's setInterval wiring", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("defaults to the real 30s cadence when pollIntervalMs is unset", async () => {
    jest.useFakeTimers();
    const store = createInMemoryRoutineStore();
    await store.createRoutine({
      tenantId: "t1",
      name: "hourly",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    let launches = 0;
    const scheduler = createRoutineScheduler({
      store,
      launcher: launcher(async () => {
        launches += 1;
        return { runId: "run_1" };
      }),
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    try {
      jest.advanceTimersByTime(DEFAULT_ROUTINE_SCHEDULER_POLL_INTERVAL_MS - 1);
      await Promise.resolve();
      expect(launches).toBe(0);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(launches).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("an injected pollIntervalMs overrides the default cadence", async () => {
    jest.useFakeTimers();
    const store = createInMemoryRoutineStore();
    await store.createRoutine({
      tenantId: "t1",
      name: "hourly",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryWorkbenchId: "ch_delivery",
      createdBy: "user_1",
    });
    let launches = 0;
    const scheduler = createRoutineScheduler({
      store,
      launcher: launcher(async () => {
        launches += 1;
        return { runId: "run_1" };
      }),
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      pollIntervalMs: 500,
    });
    try {
      jest.advanceTimersByTime(499);
      await Promise.resolve();
      expect(launches).toBe(0);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(launches).toBe(1);
    } finally {
      scheduler.stop();
    }
  });
});
