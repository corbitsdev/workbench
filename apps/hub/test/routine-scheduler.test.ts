// The scheduler loop's two failure modes, proven against a single
// deterministic poll (`tickRoutineScheduler`) rather than the real
// `setInterval` wrapper: a launch that throws must not strand the
// routine past its next natural cadence, and a successful launch must
// still record the correlation exactly once.
import { describe, expect, test } from "bun:test";
import {
  createInMemoryRoutineStore,
  type RoutineLauncher,
} from "@corbits/routines";
import { tickRoutineScheduler } from "../src/routine-scheduler";

const TENANT_ID = "tnt_1";

function throwingLauncher(): RoutineLauncher {
  return {
    async launchRoutineRun() {
      throw new Error("launcher unavailable");
    },
  };
}

function succeedingLauncher(): RoutineLauncher & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async launchRoutineRun() {
      calls += 1;
      return { runId: `run_${calls}` };
    },
  };
}

describe("tickRoutineScheduler", () => {
  test("a due routine fires and its run is recorded", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = succeedingLauncher();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const fireAt = routine.nextFireAt;
    if (fireAt === null) throw new Error("expected a scheduled fire time");

    await tickRoutineScheduler({ store, launcher }, fireAt);

    expect(launcher.calls).toBe(1);
    const runs = await store.listRunsForRoutine(TENANT_ID, routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggeredBy).toBe("schedule");
  });

  test("a launch failure restores nextFireAt instead of stranding the routine", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = throwingLauncher();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const fireAt = routine.nextFireAt;
    if (fireAt === null) throw new Error("expected a scheduled fire time");

    await tickRoutineScheduler({ store, launcher }, fireAt);

    // No run was recorded — the launch never succeeded.
    const runs = await store.listRunsForRoutine(TENANT_ID, routine.id);
    expect(runs).toHaveLength(0);

    // And the routine is due again at the exact moment it failed, not
    // stranded until its next natural hourly cadence.
    const dueAgain = await store.listDueRoutines(fireAt);
    expect(dueAgain.map((row) => row.id)).toContain(routine.id);
  });

  test("a retried fire after a failure can still succeed", async () => {
    const store = createInMemoryRoutineStore();
    let attempts = 0;
    const flakyLauncher: RoutineLauncher = {
      async launchRoutineRun() {
        attempts += 1;
        if (attempts === 1) throw new Error("transient failure");
        return { runId: "run_retry" };
      },
    };
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const fireAt = routine.nextFireAt;
    if (fireAt === null) throw new Error("expected a scheduled fire time");

    await tickRoutineScheduler({ store, launcher: flakyLauncher }, fireAt);
    await tickRoutineScheduler({ store, launcher: flakyLauncher }, fireAt);

    expect(attempts).toBe(2);
    const runs = await store.listRunsForRoutine(TENANT_ID, routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run_retry");
  });
});
