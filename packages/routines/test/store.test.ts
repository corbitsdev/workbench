// Store-level guarantees for the scheduler's claim/fail path:
// listDue filters, atomic claim, backoff + dead-letter on failure.
import { describe, expect, test } from "bun:test";
import {
  backoffMsForFailure,
  createInMemoryRoutineStore,
  MAX_ROUTINE_FIRE_FAILURES,
} from "../src/store";
import type { RoutineTriggerT } from "../src/trigger";

const CRON: RoutineTriggerT = {
  kind: "cron",
  expression: "0 * * * *",
};

async function dueRoutine(
  store: ReturnType<typeof createInMemoryRoutineStore>,
  name = "due",
) {
  return store.createRoutine({
    tenantId: "t1",
    name,
    definitionId: "def_1",
    trigger: CRON,
    scope: "bench",
    input: {},
    createdBy: "user_1",
  });
}

describe("listDueRoutines / claimRoutineFire", () => {
  test("listDueRoutines returns only enabled, due, non-deleted, non-dead-lettered rows", async () => {
    const store = createInMemoryRoutineStore();
    const due = await dueRoutine(store);
    // Force nextFireAt into the past so it's due.
    await store.updateRoutine("t1", due.id, {
      // no-op name touch would recompute nextFire; claim path uses create nextFire
    });
    // Direct claim path: set via claim after making due by creating and
    // then claiming at a future time after nextFire is in the past.
    // create sets nextFireAt from now; use a far-future `now` for due.
    const later = new Date(Date.now() + 60 * 60 * 1000);
    // Make another disabled one
    const disabled = await dueRoutine(store, "disabled");
    await store.updateRoutine("t1", disabled.id, { enabled: false });

    const dueList = await store.listDueRoutines(later);
    expect(dueList.map((r) => r.id)).toContain(due.id);
    expect(dueList.map((r) => r.id)).not.toContain(disabled.id);
  });

  test("claimRoutineFire advances nextFireAt and stamps lastFireAt", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    // Ensure due: listDue with far future should include it if nextFireAt <= fireAt
    // create's nextFireAt is soon; use now for claim if already due, else future.
    const now = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const claimed = await store.claimRoutineFire(routine.id, now);
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("expected claimed routine");
    expect(claimed.lastFireAt?.getTime()).toBe(now.getTime());
    const claimedNext0 = claimed.nextFireAt;
    if (!claimedNext0) throw new Error("expected nextFireAt after claim");
    expect(claimedNext0.getTime()).toBeGreaterThan(now.getTime());
  });

  test("a second concurrent claim loses", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    const now = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const [a, b] = await Promise.all([
      store.claimRoutineFire(routine.id, now),
      store.claimRoutineFire(routine.id, now),
    ]);
    const winners = [a, b].filter((x) => x !== undefined);
    expect(winners).toHaveLength(1);
  });

  test("claim refuses a soft-deleted routine", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    const now = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    await store.deleteRoutine("t1", routine.id);
    expect(await store.claimRoutineFire(routine.id, now)).toBeUndefined();
  });
});

describe("markFailedFire / clearFireFailures", () => {
  test("markFailedFire backs off nextFireAt and records a schedule-failed run", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    const fireAt = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const claimed = await store.claimRoutineFire(routine.id, fireAt);
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("expected claimed routine");
    const claimedNext = claimed.nextFireAt;
    if (!claimedNext) throw new Error("expected nextFireAt after claim");

    const result = await store.markFailedFire({
      routineId: routine.id,
      tenantId: "t1",
      claimedNextFireAt: claimedNext,
      failedAt: fireAt,
      reason: "launch exploded",
    });
    expect(result).toBeDefined();
    if (!result) throw new Error("expected markFailedFire result");
    expect(result.deadLettered).toBe(false);
    expect(result.consecutiveFailures).toBe(1);
    const resultNext = result.nextFireAt;
    if (!resultNext) throw new Error("expected nextFireAt after failure");
    expect(resultNext.getTime()).toBe(
      fireAt.getTime() + backoffMsForFailure(1),
    );

    const runs = await store.listRunsForRoutine("t1", routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggeredBy).toBe("schedule-failed");
    expect(runs[0]?.error).toBe("launch exploded");
  });

  test("markFailedFire is a no-op when nextFireAt already moved", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    const fireAt = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const claimed = await store.claimRoutineFire(routine.id, fireAt);
    if (!claimed) throw new Error("expected claimed routine");
    const claimedNext = claimed.nextFireAt;
    if (!claimedNext) throw new Error("expected nextFireAt after claim");

    // Operator edits the trigger, moving nextFireAt.
    await store.updateRoutine("t1", routine.id, {
      trigger: { kind: "cron", expression: "30 * * * *" },
    });
    const afterEdit = await store.getRoutine("t1", routine.id);
    if (!afterEdit) throw new Error("expected routine after edit");
    const afterEditNext = afterEdit.nextFireAt;
    if (!afterEditNext) throw new Error("expected nextFireAt after edit");
    expect(afterEditNext.getTime()).not.toBe(claimedNext.getTime());

    const result = await store.markFailedFire({
      routineId: routine.id,
      tenantId: "t1",
      claimedNextFireAt: claimedNext,
      failedAt: fireAt,
      reason: "stale",
    });
    expect(result).toBeUndefined();

    const still = await store.getRoutine("t1", routine.id);
    if (!still) throw new Error("expected routine after no-op fail");
    const stillNext = still.nextFireAt;
    if (!stillNext) throw new Error("expected nextFireAt after no-op fail");
    expect(stillNext.getTime()).toBe(afterEditNext.getTime());
    expect(still.consecutiveFailures).toBe(0);
  });

  test("after MAX failures the routine is dead-lettered and no longer due", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    let clock = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );

    for (let i = 0; i < MAX_ROUTINE_FIRE_FAILURES; i++) {
      // Make due at clock by claiming only when nextFireAt <= clock.
      // After each failure, nextFireAt is clock + backoff; advance clock.
      const current = await store.getRoutine("t1", routine.id);
      if (!current) throw new Error("expected routine in failure loop");
      if (current.nextFireAt !== null) {
        clock = new Date(
          Math.max(clock.getTime(), current.nextFireAt.getTime()),
        );
      }
      const claimed = await store.claimRoutineFire(routine.id, clock);
      expect(claimed).toBeDefined();
      if (!claimed) throw new Error("expected claimed routine");
      const claimedNext = claimed.nextFireAt;
      if (!claimedNext) throw new Error("expected nextFireAt after claim");
      const result = await store.markFailedFire({
        routineId: routine.id,
        tenantId: "t1",
        claimedNextFireAt: claimedNext,
        failedAt: clock,
        reason: `fail ${i + 1}`,
      });
      if (!result) throw new Error("expected markFailedFire result");
      if (i < MAX_ROUTINE_FIRE_FAILURES - 1) {
        expect(result.deadLettered).toBe(false);
      } else {
        expect(result.deadLettered).toBe(true);
        expect(result.nextFireAt).toBeNull();
      }
    }

    const final = await store.getRoutine("t1", routine.id);
    if (!final) throw new Error("expected routine after dead-letter");
    expect(final.deadLetteredAt).not.toBeNull();
    expect(final.consecutiveFailures).toBe(MAX_ROUTINE_FIRE_FAILURES);
    expect(
      await store.listDueRoutines(new Date(clock.getTime() + 1e12)),
    ).toEqual([]);
    expect(await store.claimRoutineFire(routine.id, clock)).toBeUndefined();
  });

  test("clearFireFailures resets counters after a successful fire", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    const fireAt = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    const claimed = await store.claimRoutineFire(routine.id, fireAt);
    if (!claimed) throw new Error("expected claimed routine");
    const claimedNext = claimed.nextFireAt;
    if (!claimedNext) throw new Error("expected nextFireAt after claim");
    await store.markFailedFire({
      routineId: routine.id,
      tenantId: "t1",
      claimedNextFireAt: claimedNext,
      failedAt: fireAt,
      reason: "once",
    });
    await store.clearFireFailures(routine.id);
    const cleared = await store.getRoutine("t1", routine.id);
    if (!cleared) throw new Error("expected routine after clearFireFailures");
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.deadLetteredAt).toBeNull();
  });

  test("re-enabling a dead-lettered routine clears the dead-letter", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await dueRoutine(store);
    let clock = new Date(
      Math.max(Date.now(), routine.nextFireAt?.getTime() ?? 0),
    );
    for (let i = 0; i < MAX_ROUTINE_FIRE_FAILURES; i++) {
      const current = await store.getRoutine("t1", routine.id);
      if (!current) throw new Error("expected routine in failure loop");
      if (current.nextFireAt !== null) {
        clock = new Date(
          Math.max(clock.getTime(), current.nextFireAt.getTime()),
        );
      }
      const claimed = await store.claimRoutineFire(routine.id, clock);
      if (!claimed) throw new Error("expected claimed routine");
      const claimedNext = claimed.nextFireAt;
      if (!claimedNext) throw new Error("expected nextFireAt after claim");
      await store.markFailedFire({
        routineId: routine.id,
        tenantId: "t1",
        claimedNextFireAt: claimedNext,
        failedAt: clock,
        reason: `fail ${i + 1}`,
      });
    }

    const recovered = await store.updateRoutine("t1", routine.id, {
      enabled: true,
    });
    expect(recovered.deadLetteredAt).toBeNull();
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.nextFireAt).not.toBeNull();
  });
});

describe("createRoutineIfAbsent", () => {
  const presetInput = {
    tenantId: "t1",
    name: "Daily digest",
    definitionId: "def_1",
    trigger: CRON,
    scope: "bench" as const,
    input: {},
    createdBy: "user_1",
    enabled: false,
    presetKey: "workbench-digest",
  };

  test("creates the row with the requested enabled state", async () => {
    const store = createInMemoryRoutineStore();
    const result = await store.createRoutineIfAbsent(presetInput);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("expected created");
    expect(result.row.enabled).toBe(false);
    expect(result.row.presetKey).toBe("workbench-digest");
  });

  test("a second call reports existing and leaves exactly one row", async () => {
    const store = createInMemoryRoutineStore();
    await store.createRoutineIfAbsent(presetInput);
    const second = await store.createRoutineIfAbsent(presetInput);
    expect(second.outcome).toBe("existing");
    expect(await store.listRoutines("t1")).toHaveLength(1);
  });

  test("a deleted preset routine is tombstoned, never re-created", async () => {
    const store = createInMemoryRoutineStore();
    const created = await store.createRoutineIfAbsent(presetInput);
    if (created.outcome !== "created") throw new Error("expected created");
    expect(await store.deleteRoutine("t1", created.row.id)).toBe(true);
    const again = await store.createRoutineIfAbsent(presetInput);
    expect(again.outcome).toBe("tombstoned");
    expect(await store.listRoutines("t1")).toHaveLength(0);
  });
});
