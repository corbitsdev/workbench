// Proof of the two guarantees `createInMemoryRoutineStore` shares with
// its drizzle counterpart: a schedule due while nothing was polling
// stays due (survives a restart, "catch-up" not "skip"), and a fire's
// claim is exactly-once even when two schedulers race the same due
// routine.
import { describe, expect, test } from "bun:test";
import { createInMemoryRoutineStore } from "../src/store";

const TENANT_ID = "tnt_1";

function assertDate(value: Date | null): Date {
  if (value === null) throw new Error("expected a non-null Date");
  return value;
}

describe("listDueRoutines / claimRoutineFire", () => {
  test("a routine's nextFireAt is set on creation", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Every 10 minutes",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "minutes", every: 10 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    expect(routine.nextFireAt).not.toBeNull();
  });

  test("a manual routine never becomes due", async () => {
    const store = createInMemoryRoutineStore();
    await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Manual only",
      definitionId: "def_1",
      trigger: null,
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const due = await store.listDueRoutines(new Date("2099-01-01T00:00:00Z"));
    expect(due).toHaveLength(0);
  });

  test("a fire due while nothing polled stays due — no skip, only catch-up", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const scheduledFireAt = assertDate(routine.nextFireAt);

    // Simulate the hub being down through the scheduled fire and well
    // past it — a naive "does this exact minute match" scheduler would
    // never fire this routine again once that minute has passed.
    const restartedAt = new Date(scheduledFireAt.getTime() + 4 * 3_600_000);
    const due = await store.listDueRoutines(restartedAt);
    expect(due.map((row) => row.id)).toContain(routine.id);
  });

  test("claiming a due fire advances nextFireAt to the following occurrence", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });

    // Claiming well after the scheduled fire (catching up a missed one)
    // still advances from the claim moment, not from the missed slot.
    const fireAt = new Date(
      assertDate(routine.nextFireAt).getTime() + 4 * 3_600_000,
    );
    const claimed = await store.claimRoutineFire(routine.id, fireAt);
    expect(claimed?.lastFireAt?.toISOString()).toBe(fireAt.toISOString());
    expect(claimed?.nextFireAt?.toISOString()).toBe(
      new Date(fireAt.getTime() + 3_600_000).toISOString(),
    );
  });

  test("a second concurrent claim of the same fire loses", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });

    const fireAt = assertDate(routine.nextFireAt);
    const [first, second] = await Promise.all([
      store.claimRoutineFire(routine.id, fireAt),
      store.claimRoutineFire(routine.id, fireAt),
    ]);
    const winners = [first, second].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);
  });

  test("a disabled routine is never claimable even if nextFireAt is due", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Paused",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "minutes", every: 5 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    await store.updateRoutine(TENANT_ID, routine.id, { enabled: false });

    const due = await store.listDueRoutines(new Date("2099-01-01T00:00:00Z"));
    expect(due).toHaveLength(0);
    const claimed = await store.claimRoutineFire(
      routine.id,
      new Date("2099-01-01T00:00:00Z"),
    );
    expect(claimed).toBeUndefined();
  });

  test("re-enabling a routine recomputes nextFireAt from now, not from the stale value", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Toggle",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "minutes", every: 5 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    await store.updateRoutine(TENANT_ID, routine.id, { enabled: false });
    const reEnabled = await store.updateRoutine(TENANT_ID, routine.id, {
      enabled: true,
    });
    expect(reEnabled.nextFireAt).not.toBeNull();
    expect(reEnabled.nextFireAt?.getTime()).toBeGreaterThan(Date.now());
  });

  test("compensateFailedFire restores nextFireAt when nothing has changed since the claim", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const fireAt = assertDate(routine.nextFireAt);
    const claimed = assertDate(
      (await store.claimRoutineFire(routine.id, fireAt))?.nextFireAt ?? null,
    );

    await store.compensateFailedFire(routine.id, fireAt, claimed);

    const restored = await store.getRoutine(TENANT_ID, routine.id);
    expect(restored?.nextFireAt?.toISOString()).toBe(fireAt.toISOString());
  });

  test("compensateFailedFire is a no-op when a trigger edit already moved nextFireAt", async () => {
    const store = createInMemoryRoutineStore();
    const routine = await store.createRoutine({
      tenantId: TENANT_ID,
      name: "Hourly",
      definitionId: "def_1",
      trigger: { kind: "interval", unit: "hours", every: 1 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const fireAt = assertDate(routine.nextFireAt);
    const claimedResult = await store.claimRoutineFire(routine.id, fireAt);
    const claimedNextFireAt = assertDate(claimedResult?.nextFireAt ?? null);

    // A trigger edit lands during the failure window, after the claim
    // but before the launch's failure is handled — this already gave
    // the routine a fresh, unrelated nextFireAt.
    const edited = await store.updateRoutine(TENANT_ID, routine.id, {
      trigger: { kind: "interval", unit: "minutes", every: 30 },
    });
    const editedNextFireAt = assertDate(edited.nextFireAt);
    expect(editedNextFireAt.getTime()).not.toBe(claimedNextFireAt.getTime());

    // Compensation must not clobber that newer value with the stale
    // one computed from the pre-edit trigger.
    await store.compensateFailedFire(routine.id, fireAt, claimedNextFireAt);

    const afterCompensation = await store.getRoutine(TENANT_ID, routine.id);
    expect(afterCompensation?.nextFireAt?.toISOString()).toBe(
      editedNextFireAt.toISOString(),
    );
  });
});
