import { describe, expect, it } from "bun:test";
import type { HubDb } from "../db";
import type { ScheduledTriggerRow } from "../db/schema";
import { shouldFire, windowIndexFor } from "../services/scheduler";
import {
  createOwnerSchedule,
  deleteOwnerSchedule,
  ensureOwnerSchedule,
  getOwnerSchedule,
  listEnabledSchedules,
  listTenantScopedSchedules,
  markScheduleFired,
  toApiSchedule,
  updateOwnerSchedule,
  updateTenantScopedSchedule,
} from "./scheduled-triggers";

// Far below any realistic window index — "always overdue", the closest
// stand-in for "never fired" now that the column is NOT NULL by construction
// (see scheduler.ts ScheduledTriggerRow).
const NEVER_FIRED = Number.MIN_SAFE_INTEGER;

function dbRow(
  overrides: Partial<ScheduledTriggerRow> = {},
): ScheduledTriggerRow {
  return {
    id: "sch-1",
    tenantId: "tenant-root",
    ownerMemberPrincipalId: "principal-1",
    workflowKind: "heartbeat",
    name: "heartbeat",
    intervalMinutes: 1440,
    anchorMinuteUtc: 13 * 60,
    scope: "personal",
    triggerPayload: { reason: "scheduled-heartbeat" },
    enabled: true,
    lastFiredWindowIndex: NEVER_FIRED,
    lastRunId: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toApiSchedule", () => {
  it("maps a DB row to the API shape with an ISO createdAt", () => {
    const now = new Date("2026-01-02T12:00:00.000Z");
    expect(
      toApiSchedule(dbRow({ anchorMinuteUtc: 9 * 60, enabled: false }), now),
    ).toEqual({
      id: "sch-1",
      workflowKind: "heartbeat",
      name: "heartbeat",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 },
      enabled: false,
      scope: "personal",
      ownerMemberPrincipalId: "principal-1",
      triggerPayload: { reason: "scheduled-heartbeat" },
      createdAt: "2026-01-02T00:00:00.000Z",
      lastRunId: null,
      recentFires: [],
      nextFireAt: null,
    });
  });

  it("computes nextFireAt for enabled schedules from hub clock", () => {
    // A far-overdue lastFiredWindowIndex (the default dbRow() fixture) is
    // treated as immediately due under the catch-up rule — nextFireAt
    // reports the boundary of the window `now` currently sits in, not a
    // future occurrence.
    const now = new Date("2026-01-02T10:00:00.000Z");
    const api = toApiSchedule(
      dbRow({ anchorMinuteUtc: 13 * 60, enabled: true }),
      now,
    );
    expect(api.nextFireAt).toBe("2026-01-01T13:00:00.000Z");
  });

  it("computes nextFireAt as the next occurrence when properly stamped and not yet fired this window", () => {
    const now = new Date("2026-01-02T10:00:00.000Z");
    const anchorMinuteUtc = 13 * 60;
    const nowMinute = Math.floor(now.getTime() / 60_000);
    const currentWindow = Math.floor((nowMinute - anchorMinuteUtc) / 1440);
    const api = toApiSchedule(
      dbRow({
        anchorMinuteUtc,
        enabled: true,
        lastFiredWindowIndex: currentWindow - 1,
      }),
      now,
    );
    expect(api.nextFireAt).toBe("2026-01-01T13:00:00.000Z");
  });

  it("exposes the schedule's recurrence, not a bookkeeping field", () => {
    const api = toApiSchedule(dbRow({ lastFiredWindowIndex: 42 }));
    expect(api.recurrence).toEqual({
      intervalMinutes: 1440,
      anchorMinuteUtc: 13 * 60,
    });
    expect(api).not.toHaveProperty("lastFiredDayUtc");
    expect(api).not.toHaveProperty("lastFiredWindowIndex");
  });
});

describe("listEnabledSchedules", () => {
  it("maps DB rows to the scheduler's row shape", async () => {
    const db = {
      query: {
        scheduledTrigger: {
          findMany: async () => [
            dbRow({
              id: "a",
              lastFiredWindowIndex: 42,
              triggerPayload: { k: 1 },
            }),
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
        intervalMinutes: 1440,
        anchorMinuteUtc: 13 * 60,
        lastFiredWindowIndex: 42,
        ownerMemberPrincipalId: "principal-1",
        triggerPayload: { k: 1 },
      },
    ]);
  });
});

describe("markScheduleFired", () => {
  it("sets last_fired_window_index for the given id", async () => {
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
    expect(setValue).toEqual({ lastFiredWindowIndex: 99 });
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

  it("replaces the trigger payload when provided", async () => {
    let patch: unknown;
    const row = dbRow({ triggerPayload: { audience: "founders" } });
    const result = await updateOwnerSchedule(
      updateDb([row], (v) => (patch = v)),
      {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
        triggerPayload: { audience: "founders" },
      },
    );
    expect(result).toEqual(row);
    expect(patch).toEqual({ triggerPayload: { audience: "founders" } });
  });

  it("returns the updated row and only patches provided fields", async () => {
    let patch: unknown;
    const row = dbRow({ anchorMinuteUtc: 7 * 60 });
    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    const result = await updateOwnerSchedule(
      updateDb([row], (v) => (patch = v)),
      {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 7 * 60 },
        now: () => fixedNow,
      },
    );
    expect(result).toEqual(row);
    expect(patch).toEqual({
      intervalMinutes: 1440,
      anchorMinuteUtc: 7 * 60,
      lastFiredWindowIndex: windowIndexFor(fixedNow, 1440, 7 * 60),
    });
  });

  it("patches a sub-daily recurrence", async () => {
    let patch: unknown;
    const row = dbRow({ intervalMinutes: 5, anchorMinuteUtc: 0 });
    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    const result = await updateOwnerSchedule(
      updateDb([row], (v) => (patch = v)),
      {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
        recurrence: { intervalMinutes: 5, anchorMinuteUtc: 0 },
        now: () => fixedNow,
      },
    );
    expect(result).toEqual(row);
    expect(patch).toEqual({
      intervalMinutes: 5,
      anchorMinuteUtc: 0,
      lastFiredWindowIndex: windowIndexFor(fixedNow, 5, 0),
    });
  });

  it("re-stamping to the new cadence's current window prevents an immediate re-fire", async () => {
    // The whole point of the stamp: after this patch, shouldFire(fixedNow, ...)
    // for the NEW recurrence must be false, because lastFiredWindowIndex now
    // equals the current window under the new cadence.
    let patch:
      | {
          intervalMinutes: number;
          anchorMinuteUtc: number;
          lastFiredWindowIndex: number;
        }
      | undefined;
    const row = dbRow();
    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    await updateOwnerSchedule(
      updateDb([row], (v) => (patch = v as never)),
      {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
        recurrence: { intervalMinutes: 5, anchorMinuteUtc: 0 },
        now: () => fixedNow,
      },
    );
    expect(patch).toBeDefined();
    expect(
      shouldFire(
        fixedNow,
        patch!.lastFiredWindowIndex,
        patch!.intervalMinutes,
        patch!.anchorMinuteUtc,
      ),
    ).toBe(false);
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
        name: "heartbeat",
        recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it("writes intervalMinutes and anchorMinuteUtc from the recurrence", async () => {
    let values: unknown;
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values = v;
          return { returning: async () => [dbRow()] };
        },
      }),
    } as unknown as HubDb;
    await createOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "granola-call",
      name: "granola-call",
      recurrence: { intervalMinutes: 5, anchorMinuteUtc: 0 },
      payload: {},
    });
    expect(values).toMatchObject({ intervalMinutes: 5, anchorMinuteUtc: 0 });
  });

  it("stamps lastFiredWindowIndex to the current window so it cannot fire immediately", async () => {
    let values: { lastFiredWindowIndex?: number } | undefined;
    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values = v as { lastFiredWindowIndex?: number };
          return { returning: async () => [dbRow()] };
        },
      }),
    } as unknown as HubDb;
    await createOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "granola-call",
      name: "granola-call",
      recurrence: { intervalMinutes: 5, anchorMinuteUtc: 0 },
      payload: {},
      now: () => fixedNow,
    });
    const stamped = values?.lastFiredWindowIndex;
    expect(stamped).toBe(windowIndexFor(fixedNow, 5, 0));
    // And that stamp really does block an immediate fire at the moment of
    // creation — the property this exists for.
    expect(shouldFire(fixedNow, stamped as number, 5, 0)).toBe(false);
  });

  it("defaults the name to the bare kind when the caller supplies none and no schedule of that kind exists yet", async () => {
    let values: { name?: string } | undefined;
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ n: 0 }] }),
      }),
      insert: () => ({
        values: (v: unknown) => {
          values = v as { name?: string };
          return { returning: async () => [dbRow()] };
        },
      }),
    } as unknown as HubDb;
    await createOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: {},
    });
    expect(values?.name).toBe("heartbeat");
  });

  it("numbers the default name when the owner already has schedules of that kind", async () => {
    let values: { name?: string } | undefined;
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ n: 2 }] }),
      }),
      insert: () => ({
        values: (v: unknown) => {
          values = v as { name?: string };
          return { returning: async () => [dbRow()] };
        },
      }),
    } as unknown as HubDb;
    await createOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: {},
    });
    expect(values?.name).toBe("heartbeat 3");
  });

  it("uses the caller-supplied name verbatim when given", async () => {
    let values: { name?: string } | undefined;
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values = v as { name?: string };
          return { returning: async () => [dbRow()] };
        },
      }),
    } as unknown as HubDb;
    await createOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      name: "Weekend digest",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: {},
    });
    expect(values?.name).toBe("Weekend digest");
  });
});

describe("ensureOwnerSchedule", () => {
  it("inserts a personal schedule when none exists", async () => {
    let values: unknown;
    let findWhere: unknown;
    const db = {
      query: {
        scheduledTrigger: {
          findFirst: async (opts: { where: unknown }) => {
            findWhere = opts.where;
            return undefined;
          },
        },
      },
      insert: () => ({
        values: async (v: unknown) => {
          values = v;
        },
      }),
    } as unknown as HubDb;

    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    await ensureOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      name: "Morning brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: { reason: "scheduled-heartbeat" },
      now: () => fixedNow,
    });

    expect(findWhere).toBeDefined();
    expect(values).toEqual({
      tenantId: "tenant-root",
      ownerMemberPrincipalId: "principal-1",
      workflowKind: "heartbeat",
      name: "Morning brief",
      intervalMinutes: 1440,
      anchorMinuteUtc: 13 * 60,
      lastFiredWindowIndex: windowIndexFor(fixedNow, 1440, 13 * 60),
      triggerPayload: { reason: "scheduled-heartbeat" },
      scope: "personal",
    });
  });

  it("skips insert when a personal schedule of that kind AND name already exists", async () => {
    let inserted = false;
    const db = {
      query: {
        scheduledTrigger: {
          findFirst: async () => ({ id: "sch-existing" }),
        },
      },
      insert: () => {
        inserted = true;
        return { values: async () => undefined };
      },
    } as unknown as HubDb;

    await ensureOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      name: "Morning brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: { reason: "scheduled-heartbeat" },
    });

    expect(inserted).toBe(false);
  });

  it("still inserts the default-named schedule even when the owner has a differently-named schedule of the same kind", async () => {
    let insertedName: string | undefined;
    const db = {
      query: {
        scheduledTrigger: {
          // Simulates the (tenant, owner, kind, scope, name) filter finding
          // no row: the owner has a "heartbeat" kind schedule, but named
          // something the member picked themselves, not the seeder's default.
          findFirst: async () => undefined,
        },
      },
      insert: () => ({
        values: async (v: { name: string }) => {
          insertedName = v.name;
        },
      }),
    } as unknown as HubDb;

    await ensureOwnerSchedule(db, {
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-1",
      kind: "heartbeat",
      name: "Morning brief",
      recurrence: { intervalMinutes: 1440, anchorMinuteUtc: 13 * 60 },
      payload: { reason: "scheduled-heartbeat" },
    });

    expect(insertedName).toBe("Morning brief");
  });
});

describe("listTenantScopedSchedules (CL-4113)", () => {
  it("queries only tenant-scoped rows for the given tenant", async () => {
    let findOpts: unknown;
    const rows = [dbRow({ scope: "tenant", workflowKind: "deck" })];
    const db = {
      query: {
        scheduledTrigger: {
          findMany: async (opts: unknown) => {
            findOpts = opts;
            return rows;
          },
        },
      },
    } as unknown as HubDb;

    const result = await listTenantScopedSchedules(db, "tenant-root");
    expect(result).toEqual(rows);
    expect(findOpts).toBeDefined();
  });
});

describe("updateTenantScopedSchedule (CL-4113)", () => {
  it("returns null when no tenant-scoped row matches", async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    } as unknown as HubDb;
    expect(
      await updateTenantScopedSchedule(db, {
        tenantId: "tenant-root",
        id: "sch-missing",
        enabled: false,
      }),
    ).toBeNull();
  });

  it("returns the updated row when a tenant schedule matches", async () => {
    const updated = dbRow({
      id: "sch-tenant",
      scope: "tenant",
      enabled: false,
    });
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [updated],
          }),
        }),
      }),
    } as unknown as HubDb;
    expect(
      await updateTenantScopedSchedule(db, {
        tenantId: "tenant-root",
        id: "sch-tenant",
        enabled: false,
      }),
    ).toEqual(updated);
  });

  it("patches recurrence when provided", async () => {
    let patch: unknown;
    const updated = dbRow({ id: "sch-tenant", scope: "tenant" });
    const fixedNow = Date.UTC(2026, 0, 2, 12, 0, 0);
    const db = {
      update: () => ({
        set: (v: unknown) => {
          patch = v;
          return {
            where: () => ({
              returning: async () => [updated],
            }),
          };
        },
      }),
    } as unknown as HubDb;
    await updateTenantScopedSchedule(db, {
      tenantId: "tenant-root",
      id: "sch-tenant",
      recurrence: { intervalMinutes: 15, anchorMinuteUtc: 0 },
      now: () => fixedNow,
    });
    expect(patch).toEqual({
      intervalMinutes: 15,
      anchorMinuteUtc: 0,
      lastFiredWindowIndex: windowIndexFor(fixedNow, 15, 0),
    });
  });
});

describe("getOwnerSchedule", () => {
  it("returns null when no row matches", async () => {
    const db = {
      query: {
        scheduledTrigger: { findFirst: async () => undefined },
      },
    } as unknown as HubDb;
    expect(
      await getOwnerSchedule(db, {
        tenantId: "tenant-root",
        ownerPrincipalId: "principal-1",
        id: "sch-1",
      }),
    ).toBeNull();
  });
});
