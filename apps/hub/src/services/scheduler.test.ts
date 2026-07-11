import { describe, expect, it } from "bun:test";
import {
  createScheduler,
  shouldFire,
  type ScheduledTriggerRow,
} from "./scheduler";

// 2026-01-02T13:00:00Z. UTC hour 13; UTC day index = floor(ms / 86_400_000).
const AT_13 = Date.UTC(2026, 0, 2, 13, 0, 0);
const DAY_AT_13 = Math.floor(AT_13 / 86_400_000);
const AT_12 = Date.UTC(2026, 0, 2, 12, 30, 0);
const NEXT_DAY_13 = AT_13 + 86_400_000;

function row(
  overrides: Partial<ScheduledTriggerRow> = {},
): ScheduledTriggerRow {
  return {
    id: "sch-1",
    tenantId: "tenant-root",
    workflowKind: "heartbeat",
    hourUtc: 13,
    lastFiredDayUtc: null,
    ownerMemberPrincipalId: "principal-1",
    triggerPayload: { reason: "scheduled-heartbeat" },
    ...overrides,
  };
}

// In-memory durable store: markFired mutates lastFiredDayUtc, listSchedules
// reflects it — modelling the real DB so a second tick sees the persisted
// marker (the anti-double-fire mechanism).
function makeStore(rows: ScheduledTriggerRow[]) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    listSchedules: async () => [...byId.values()].map((r) => ({ ...r })),
    markFired: async (id: string, dayUtc: number) => {
      const r = byId.get(id);
      if (r) r.lastFiredDayUtc = dayUtc;
    },
  };
}

describe("shouldFire", () => {
  it("fires at the target hour when never fired", () => {
    expect(shouldFire(AT_13, null, 13)).toBe(true);
  });
  it("does not fire off-hour", () => {
    expect(shouldFire(AT_12, null, 13)).toBe(false);
  });
  it("does not fire again once fired today", () => {
    expect(shouldFire(AT_13, DAY_AT_13, 13)).toBe(false);
  });
  it("fires again the next UTC day", () => {
    expect(shouldFire(NEXT_DAY_13, DAY_AT_13, 13)).toBe(true);
  });
});

describe("createScheduler", () => {
  it("fires each due target with its own kind, tenant, creator, and payload", async () => {
    const calls: {
      kind: string;
      tenantId: string;
      creatorPrincipalId: string;
      triggerPayload: Record<string, unknown>;
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
      enabled: true,
      ...store,
      startWorkflowRun: async (a) => {
        calls.push(a);
        return { deploymentId: `dep-${a.creatorPrincipalId}`, accepted: true };
      },
    });

    await scheduler.tick(AT_13);

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({
      kind: "heartbeat",
      tenantId: "tenant-root",
      creatorPrincipalId: "principal-a",
      triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-a" },
    });
    expect(calls).toContainEqual({
      kind: "heartbeat",
      tenantId: "tenant-root",
      creatorPrincipalId: "principal-b",
      triggerPayload: { reason: "scheduled-heartbeat", userRefId: "user-b" },
    });
  });

  it("does not fire a schedule twice within the same hour across ticks", async () => {
    let fires = 0;
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      enabled: true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true };
      },
    });

    await scheduler.tick(AT_13);
    await scheduler.tick(AT_13 + 30_000);

    expect(fires).toBe(1);
  });

  it("one target failing does not block the others", async () => {
    const fired: string[] = [];
    const store = makeStore([
      row({ id: "sch-a", ownerMemberPrincipalId: "principal-a" }),
      row({ id: "sch-b", ownerMemberPrincipalId: "principal-b" }),
    ]);
    const scheduler = createScheduler({
      enabled: true,
      ...store,
      startWorkflowRun: async (a) => {
        if (a.creatorPrincipalId === "principal-a") {
          throw new Error("run-start blew up");
        }
        fired.push(a.creatorPrincipalId);
        return { deploymentId: "dep-b", accepted: true };
      },
    });

    await scheduler.tick(AT_13);

    expect(fired).toEqual(["principal-b"]);
  });

  it("does not fire when disabled", async () => {
    let fires = 0;
    const store = makeStore([row()]);
    const scheduler = createScheduler({
      enabled: false,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true };
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
      enabled: true,
      ...store,
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true };
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
      enabled: true,
      listSchedules: async () => [row()],
      markFired: async () => {
        throw new Error("db down");
      },
      startWorkflowRun: async () => {
        fires += 1;
        return { deploymentId: "dep-1", accepted: true };
      },
    });

    await scheduler.tick(AT_13);

    expect(fires).toBe(0);
  });
});
