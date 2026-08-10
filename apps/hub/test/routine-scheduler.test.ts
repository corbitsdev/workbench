// Scheduler poller: claim → fire, backoff on failure, dead-letter at max.
import { describe, expect, test } from "bun:test";
import {
  backoffMsForFailure,
  createInMemoryRoutineStore,
  MAX_ROUTINE_FIRE_FAILURES,
  type RoutineLauncher,
} from "@corbits/routines";
import { tickRoutineScheduler } from "../src/routine-scheduler";

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
      deliveryChannelId: "ch_delivery",
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

  test("a launch failure backs off and records schedule-failed", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: "t1",
      name: "flaky",
      definitionId: "def_1",
      trigger: CRON,
      scope: "bench",
      input: {},
      deliveryChannelId: "ch_delivery",
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
      deliveryChannelId: "ch_delivery",
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
      deliveryChannelId: "ch_delivery",
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
