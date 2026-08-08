// Exercises the tick loop's own wiring: due-computation against the
// store, advancing `nextRunAt` after every fire (success or failure),
// and non-overlap. `computeNextRun`'s own arithmetic is covered by
// `trigger.test.ts`.
import { describe, expect, test } from "bun:test";
import { createScheduler, type ScheduleLogger } from "../src/scheduler";
import { createInMemoryScheduleStore } from "../src/store";
import type { ScheduleLauncher } from "../src/launcher";

function fakeLogger(): ScheduleLogger {
  const noop = () => undefined;
  const tag = () => noop;
  return {
    error: tag,
    warn: tag,
    info: tag,
    debug: tag,
    fatal: tag,
    trace: tag,
  } as unknown as ScheduleLogger;
}

describe("createScheduler", () => {
  test("launches every due schedule and advances nextRunAt", async () => {
    const store = createInMemoryScheduleStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await store.create({
      id: "sch_due",
      tenantId: "tnt_1",
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: now,
    });
    await store.create({
      id: "sch_future",
      tenantId: "tnt_1",
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: new Date(now.getTime() + 3_600_000),
    });

    const launched: string[] = [];
    const launcher: ScheduleLauncher = {
      async launchScheduledRun(input) {
        launched.push(input.scheduleId);
        return { instanceId: "ins_1", address: "ins_1@acme.example" };
      },
    };

    const scheduler = createScheduler({
      store,
      launcher,
      log: fakeLogger(),
      tickIntervalMs: 1_000,
      now: () => now,
    });

    await scheduler.tickOnce();

    expect(launched).toEqual(["sch_due"]);
    const due = await store.get("tnt_1", "sch_due");
    expect(due?.lastRunAt?.getTime()).toBe(now.getTime());
    expect(due?.nextRunAt.getTime()).toBe(now.getTime() + 60_000);
    const future = await store.get("tnt_1", "sch_future");
    expect(future?.lastRunAt).toBeNull();
  });

  test("a launch failure still advances nextRunAt instead of looping forever", async () => {
    const store = createInMemoryScheduleStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await store.create({
      id: "sch_broken",
      tenantId: "tnt_1",
      workflowDefinitionId: "wfd_missing",
      trigger: { kind: "interval", ms: 30_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: now,
    });

    const launcher: ScheduleLauncher = {
      async launchScheduledRun() {
        throw new Error("definition not deployed");
      },
    };

    const errors: string[] = [];
    const log = fakeLogger();
    (
      log as unknown as {
        error: (strings: TemplateStringsArray, ...v: unknown[]) => void;
      }
    ).error = (strings, ...values) => {
      errors.push(
        strings.reduce((acc, s, i) => acc + s + String(values[i] ?? ""), ""),
      );
    };

    const scheduler = createScheduler({
      store,
      launcher,
      log,
      tickIntervalMs: 1_000,
      now: () => now,
    });

    await scheduler.tickOnce();

    const row = await store.get("tnt_1", "sch_broken");
    expect(row?.nextRunAt.getTime()).toBe(now.getTime() + 30_000);
    expect(errors.some((e) => e.includes("sch_broken"))).toBe(true);
  });

  test("a still-running tick coalesces the next one instead of overlapping", async () => {
    const store = createInMemoryScheduleStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await store.create({
      id: "sch_slow",
      tenantId: "tnt_1",
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: now,
    });

    let concurrent = 0;
    let maxConcurrent = 0;
    let resolveFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const launcher: ScheduleLauncher = {
      async launchScheduledRun() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        resolveFirst?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return { instanceId: "ins_1", address: "ins_1@acme.example" };
      },
    };

    const scheduler = createScheduler({
      store,
      launcher,
      log: fakeLogger(),
      tickIntervalMs: 1_000,
      now: () => now,
    });

    const firstTick = scheduler.tickOnce();
    await started;
    await scheduler.tickOnce();
    await firstTick;

    expect(maxConcurrent).toBe(1);
  });
});
