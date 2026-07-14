import { describe, expect, it } from "bun:test";
import type { HubDb } from "../db";
import type { ScheduledTriggerRow } from "../db/schema";
import {
  createOwnerSchedule,
  deleteOwnerSchedule,
  ensureOwnerSchedule,
  listEnabledSchedules,
  markScheduleFired,
  toApiSchedule,
  updateOwnerSchedule,
} from "./scheduled-triggers";

function dbRow(
  overrides: Partial<ScheduledTriggerRow> = {},
): ScheduledTriggerRow {
  return {
    id: "sch-1",
    tenantId: "tenant-root",
    ownerMemberPrincipalId: "principal-1",
    workflowKind: "heartbeat",
    hourUtc: 13,
    triggerPayload: { reason: "scheduled-heartbeat" },
    enabled: true,
    lastFiredDayUtc: null,
    lastRunId: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toApiSchedule", () => {
  it("maps a DB row to the API shape with an ISO createdAt", () => {
    const now = new Date("2026-01-02T12:00:00.000Z");
    expect(toApiSchedule(dbRow({ hourUtc: 9, enabled: false }), now)).toEqual({
      id: "sch-1",
      workflowKind: "heartbeat",
      hourUtc: 9,
      enabled: false,
      triggerPayload: { reason: "scheduled-heartbeat" },
      createdAt: "2026-01-02T00:00:00.000Z",
      lastFiredDayUtc: null,
      lastRunId: null,
      recentFires: [],
      nextFireAt: null,
    });
  });

  it("computes nextFireAt for enabled schedules from hub clock", () => {
    const now = new Date("2026-01-02T10:00:00.000Z");
    const api = toApiSchedule(dbRow({ hourUtc: 13, enabled: true }), now);
    expect(api.nextFireAt).toBe("2026-01-02T13:00:00.000Z");
  });

  it("carries a non-null lastFiredDayUtc through", () => {
    expect(toApiSchedule(dbRow({ lastFiredDayUtc: 42 })).lastFiredDayUtc).toBe(
      42,
    );
  });
});

describe("listEnabledSchedules", () => {
  it("maps DB rows to the scheduler's row shape", async () => {
    const db = {
      query: {
        scheduledTrigger: {
          findMany: async () => [
            dbRow({ id: "a", lastFiredDayUtc: 42, triggerPayload: { k: 1 } }),
          ],
        },
      },
    } as unknown as HubDb;

    const rows = await listEnabledSchedules(db, "tenant-root");
    expect(rows).toEqual([
      {
        id: "a",
        tenantId: "tenant-root",
        workflowKind: "heartbeat",
        hourUtc: 13,
        lastFiredDayUtc: 42,
        ownerMemberPrincipalId: "principal-1",
        triggerPayload: { k: 1 },
      },
    ]);
  });
});

describe("markScheduleFired", () => {
  it("sets last_fired_day_utc for the given id", async () => {
    let setValue: unknown;
    const db = {
      update: () => ({
        set: (v: unknown) => {
          setValue = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as HubDb;

    await markScheduleFired(db, "sch-1", 99);
    expect(setValue).toEqual({ lastFiredDayUtc: 99 });
  });
});

// Fake `.update().set().where().returning()` that yields the given rows.
function updateDb(
  returning: ScheduledTriggerRow[],
  capture?: (v: unknown) => void,
) {
  return {
    update: () => ({
      set: (v: unknown) => {
        capture?.(v);
        return { where: () => ({ returning: async () => returning }) };
      },
    }),
  } as unknown as HubDb;
}

describe("updateOwnerSchedule", () => {
  it("returns null when no row matches the owner-scoped filter", async () => {
    const result = await updateOwnerSchedule(updateDb([]), {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      id: "sch-1",
      enabled: false,
    });
    expect(result).toBeNull();
  });

  it("returns the updated row and only patches provided fields", async () => {
    let patch: unknown;
    const row = dbRow({ hourUtc: 7 });
    const result = await updateOwnerSchedule(
      updateDb([row], (v) => (patch = v)),
      {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
        hourUtc: 7,
      },
    );
    expect(result).toEqual(row);
    expect(patch).toEqual({ hourUtc: 7 });
  });
});

describe("deleteOwnerSchedule", () => {
  function deleteDb(returning: { id: string }[]) {
    return {
      delete: () => ({
        where: () => ({ returning: async () => returning }),
      }),
    } as unknown as HubDb;
  }

  it("returns false when nothing matched the owner-scoped filter", async () => {
    expect(
      await deleteOwnerSchedule(deleteDb([]), {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
      }),
    ).toBe(false);
  });

  it("returns true when a row was deleted", async () => {
    expect(
      await deleteOwnerSchedule(deleteDb([{ id: "sch-1" }]), {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
      }),
    ).toBe(true);
  });
});

describe("createOwnerSchedule", () => {
  it("throws when the insert returns no row", async () => {
    const db = {
      insert: () => ({
        values: () => ({ returning: async () => [] }),
      }),
    } as unknown as HubDb;
    await expect(
      createOwnerSchedule(db, {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        kind: "heartbeat",
        hourUtc: 13,
        payload: {},
      }),
    ).rejects.toThrow();
  });
});

describe("ensureOwnerSchedule", () => {
  it("inserts with onConflictDoNothing so an existing row is preserved", async () => {
    let values: unknown;
    let conflict: unknown;
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values = v;
          return {
            onConflictDoNothing: async (c: unknown) => {
              conflict = c;
            },
          };
        },
      }),
    } as unknown as HubDb;

    await ensureOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      hourUtc: 13,
      payload: { reason: "scheduled-heartbeat" },
    });

    expect(values).toEqual({
      tenantId: "tenant-root",
      ownerMemberPrincipalId: "principal-1",
      workflowKind: "heartbeat",
      hourUtc: 13,
      triggerPayload: { reason: "scheduled-heartbeat" },
    });
    expect(conflict).toBeDefined();
  });
});
