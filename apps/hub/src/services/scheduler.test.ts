import { describe, expect, it } from "bun:test";
import {
  createScheduler,
  shouldFire,
  windowIndexFor,
  type ScheduledTriggerRow,
} from "./scheduler";

// 2026-01-02T13:00:00Z. Daily-at-hour cadence: intervalMinutes=1440,
// anchorMinuteUtc=13*60. The window index for this cadence is numerically the
// UTC day index (floor(ms / 86_400_000)) — the migration relies on this.
const AT_13 = Date.UTC(2026, 0, 2, 13, 0, 0);
const DAILY_WINDOW_AT_13 = windowIndexFor(AT_13, 1440, 13 * 60);
const AT_12 = Date.UTC(2026, 0, 2, 12, 30, 0);
const NEXT_DAY_13 = AT_13 + 86_400_000;

// A sentinel far below any realistic window index — stands in for "always
// overdue" (the closest thing to the old "never fired" state now that
// `lastFiredWindowIndex` is NOT NULL by construction; see scheduler.ts).
const NEVER_FIRED = Number.MIN_SAFE_INTEGER;

function row(
  overrides: Partial<ScheduledTriggerRow> = {},
): ScheduledTriggerRow {
  return {
    id: "sch-1",
    tenantId: "tenant-root",
    workflowKind: "heartbeat",
    intervalMinutes: 1440,
    anchorMinuteUtc: 13 * 60,
    lastFiredWindowIndex: NEVER_FIRED,
    ownerMemberPrincipalId: "principal-1",
    triggerPayload: { reason: "scheduled-heartbeat" },
    ...overrides,
  };
}

// In-memory durable store: markFired mutates lastFiredWindowIndex,
// listSchedules reflects it — modelling the real DB so a second tick sees the
// persisted marker (the anti-double-fire mechanism).
function makeStore(rows: ScheduledTriggerRow[]) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    listSchedules: async () => [...byId.values()].map((r) => ({ ...r })),
    markFired: async (id: string, windowIndex: number) => {
      const r = byId.get(id);
      if (r) r.lastFiredWindowIndex = windowIndex;
    },
  };
}

describe("windowIndexFor", () => {
  it("is numerically the UTC day index for the daily cadence", () => {
    const utcDay = Math.floor(AT_13 / 86_400_000);
    expect(windowIndexFor(AT_13, 1440, 13 * 60)).toBe(utcDay);
  });

  it("advances every intervalMinutes for a sub-daily cadence", () => {
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    const t1 = t0 + 5 * 60_000;
    expect(windowIndexFor(t1, 5, 0)).toBe(windowIndexFor(t0, 5, 0) + 1);
  });
});

describe("shouldFire", () => {
  // A catch-up rule: fires when the current window index is GREATER THAN
  // lastFiredWindowIndex, not only at the exact boundary minute. This is
  // what lets a late/skipped tick still fire on whatever tick runs next
  // (see the createScheduler "missed boundary tick" test below) — the
  // never-fired-mid-window problem this used to guard against by requiring
  // an exact match is instead solved at write time (scheduled-triggers.ts
  // stamps lastFiredWindowIndex to the CURRENT window on create/retarget).
  it("a far-overdue row fires immediately regardless of time-of-day", () => {
    expect(shouldFire(AT_13, NEVER_FIRED, 1440, 13 * 60)).toBe(true);
    expect(shouldFire(AT_12, NEVER_FIRED, 1440, 13 * 60)).toBe(true);
  });

  it("a row stamped to the current window does not fire until the window advances", () => {
    const currentWindow = windowIndexFor(AT_12, 1440, 13 * 60);
    expect(shouldFire(AT_12, currentWindow, 1440, 13 * 60)).toBe(false);
  });

  it("does not fire again once fired today", () => {
    expect(shouldFire(AT_13, DAILY_WINDOW_AT_13, 1440, 13 * 60)).toBe(false);
  });
  it("fires again the next UTC day", () => {
    expect(shouldFire(NEXT_DAY_13, DAILY_WINDOW_AT_13, 1440, 13 * 60)).toBe(
      true,
    );
  });

  it("sub-daily: fires once per 5-minute window, not again inside it", () => {
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    const w0 = windowIndexFor(t0, 5, 0);
    expect(shouldFire(t0, w0 - 1, 5, 0)).toBe(true);
    expect(shouldFire(t0 + 60_000, w0, 5, 0)).toBe(false);
    expect(shouldFire(t0 + 4 * 60_000, w0, 5, 0)).toBe(false);
  });

  it("sub-daily: fires again once the next 5-minute window is entered", () => {
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    const w0 = windowIndexFor(t0, 5, 0);
    expect(shouldFire(t0 + 5 * 60_000, w0, 5, 0)).toBe(true);
  });

  it("does not double-fire across two ticks inside the same window", () => {
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    const w0 = windowIndexFor(t0, 5, 0);
    // A tick lands mid-window (e.g. process restart skew) — still must not
    // re-fire until the window actually advances.
    expect(shouldFire(t0 + 3 * 60_000, w0, 5, 0)).toBe(false);
  });

  it("catches up when a tick misses the boundary minute entirely", () => {
    // A tick that would have landed exactly on a 5-minute boundary never ran
    // (SIGTERM drain, GC pause, the reentrancy guard dropping an overlapping
    // tick) — the NEXT tick to actually run, several minutes into the new
    // window, must still fire it rather than silently skip the occurrence.
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    const w0 = windowIndexFor(t0, 5, 0);
    const missedBoundaryTick = t0 + 5 * 60_000; // the boundary that got skipped
    const lateTick = missedBoundaryTick + 3 * 60_000; // first tick that actually runs
    expect(shouldFire(missedBoundaryTick, w0, 5, 0)).toBe(true); // would have fired
    expect(shouldFire(lateTick, w0, 5, 0)).toBe(true); // still fires, 3 min late
  });
});

describe("createScheduler", () => {
  it("fires each due target with its own kind, tenant, creator, and payload", async () => {
    const calls: {
      kind: string;
      tenantId: string;
      creatorPrincipalId: string;
      triggerPayload: Record<string, unknown>;
      lastFiredWindowIndex: number;
      intervalMinutes: number;
      anchorMinuteUtc: number;
      nowMs: number;
    }[] = [];
    const store = makeStore([
      row({
        id: "sch-a",
        ownerMemberPrincipalId: "principal-a",
        triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-a" },
      }),
      row({
        id: "sch-b",
        ownerMemberPrincipalId: "principal-b",
        tenantId: "tenant-root",
        triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-b" },
      }),
    ]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async (a) => {
        calls.push(a);
        return {
          deploymentId: `dep-${a.creatorPrincipalId}`,
          accepted: true,
          runId: `run-${a.creatorPrincipalId}`,
        };
      },
    });

    await scheduler.tick(AT_13);

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({
      kind: "heartbeat",
      tenantId: "tenant-root",
      creatorPrincipalId: "principal-a",
      triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-a" },
      lastFiredWindowIndex: NEVER_FIRED,
      intervalMinutes: 1440,
      anchorMinuteUtc: 13 * 60,
      nowMs: AT_13,
    });
    expect(calls).toContainEqual({
      kind: "heartbeat",
      tenantId: "tenant-root",
      creatorPrincipalId: "principal-b",
      triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-b" },
      lastFiredWindowIndex: NEVER_FIRED,
      intervalMinutes: 1440,
      anchorMinuteUtc: 13 * 60,
      nowMs: AT_13,
    });
  });

  it("does not fire a schedule twice within the same hour across ticks", async () => {
    let fires = 0;
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
    });

    await scheduler.tick(AT_13);
    await scheduler.tick(AT_13 + 30_000);

    expect(fires).toBe(1);
  });

  it("fires a sub-daily schedule once per window across many ticks, then again next window", async () => {
    let fires = 0;
    const store = makeStore([row({ intervalMinutes: 5, anchorMinuteUtc: 0 })]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
    });

    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    // Three ticks inside the same 5-minute window must fire exactly once.
    await scheduler.tick(t0);
    await scheduler.tick(t0 + 60_000);
    await scheduler.tick(t0 + 4 * 60_000);
    expect(fires).toBe(1);

    // A tick in the next window fires again.
    await scheduler.tick(t0 + 5 * 60_000);
    expect(fires).toBe(2);
  });

  it("fires on the first tick after a boundary was crossed with no tick landing on it", async () => {
    // The deliverable for the missed-tick fix: simulate a tick loop where the
    // boundary-minute tick never ran at all (dropped by the reentrancy guard,
    // a GC pause, a SIGTERM drain) — the schedule must still fire on the
    // NEXT tick that actually executes, not be silently skipped until the
    // window after next.
    let fires = 0;
    const t0 = Date.UTC(2026, 0, 2, 13, 0, 0);
    // Stamped at creation to the window t0 falls in — matches how
    // createOwnerSchedule/ensureOwnerSchedule now write a fresh row.
    const store = makeStore([
      row({
        intervalMinutes: 5,
        anchorMinuteUtc: 0,
        lastFiredWindowIndex: windowIndexFor(t0, 5, 0),
      }),
    ]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
    });

    // The boundary tick at t0 + 5min never happens — jump straight to a tick
    // 8 minutes later, well past the boundary and into the FOLLOWING window.
    const missedBoundary = t0 + 5 * 60_000;
    const lateTick = missedBoundary + 3 * 60_000;
    await scheduler.tick(lateTick);

    expect(fires).toBe(1);

    // And it does not re-fire on the very next on-time tick in that same
    // window — the catch-up fire consumed the window exactly once.
    await scheduler.tick(lateTick + 60_000);
    expect(fires).toBe(1);
  });

  it("one target failing does not block the others", async () => {
    const fired: string[] = [];
    const store = makeStore([
      row({ id: "sch-a", ownerMemberPrincipalId: "principal-a" }),
      row({ id: "sch-b", ownerMemberPrincipalId: "principal-b" }),
    ]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async (a) => {
        if (a.creatorPrincipalId === "principal-a") {
          throw new Error("run-start blew up");
        }
        fired.push(a.creatorPrincipalId);
        return { deploymentId: "dep-b", accepted: true, runId: "run-b" };
      },
    });

    await scheduler.tick(AT_13);

    expect(fired).toEqual(["principal-b"]);
  });

  it("does not fire when the tenant predicate resolves false", async () => {
    let fires = 0;
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => false,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
      tickIntervalMs: 1,
      now: () => AT_13,
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();

    expect(fires).toBe(0);
  });

  it("stops firing after stop()", async () => {
    let fires = 0;
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
      tickIntervalMs: 5,
      now: () => AT_13,
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();
    const afterStop = fires;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Fired once (marker persists, so repeated ticks are no-ops) and nothing
    // after stop.
    expect(afterStop).toBe(1);
    expect(fires).toBe(afterStop);
  });

  it("does not fire the run if the fired-marker cannot be persisted", async () => {
    let fires = 0;
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      listSchedules: async () => [row()],
      markFired: async () => {
        throw new Error("db down");
      },
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true, runId: "run-1" };
      },
    });

    await scheduler.tick(AT_13);

    expect(fires).toBe(0);
  });

  it("evaluates isTenantEnabled per row so different tenants can differ", async () => {
    const fired: string[] = [];
    const store = makeStore([
      row({ id: "sch-a", tenantId: "tenant-a", ownerMemberPrincipalId: "p-a" }),
      row({ id: "sch-b", tenantId: "tenant-b", ownerMemberPrincipalId: "p-b" }),
    ]);
    const scheduler = createScheduler({
      isTenantEnabled: async (tenantId) => tenantId === "tenant-a",
      ...store,
      startWorkflowRun: async (a) => {
        fired.push(a.tenantId);
        return {
          deploymentId: `dep-${a.tenantId}`,
          accepted: true,
          runId: `run-${a.tenantId}`,
        };
      },
    });

    await scheduler.tick(AT_13);

    expect(fired).toEqual(["tenant-a"]);
  });

  it("records the started run id when recordRunStarted is wired", async () => {
    const recorded: { scheduleId: string; tenantId: string; runId: string }[] =
      [];
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      isTenantEnabled: async () => true,
      ...store,
      recordRunStarted: async (args) => {
        recorded.push(args);
      },
      startWorkflowRun: async () => ({
        deploymentId: "dep-1",
        accepted: true,
        runId: "run-sched-1",
      }),
    });

    await scheduler.tick(AT_13);

    expect(recorded).toEqual([
      {
        scheduleId: "sch-1",
        tenantId: "tenant-root",
        runId: "run-sched-1",
      },
    ]);
  });
});
