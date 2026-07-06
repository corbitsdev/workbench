import { describe, expect, it, mock } from "bun:test";

const resolvePrincipalNames = mock(
  async () =>
    new Map([
      ["prn_actor", "Alice"],
      ["prn_target", "Bob"],
    ]),
);
mock.module("./admin-governance", () => ({ resolvePrincipalNames }));

const { recordAudit, listAuditRecords } = await import("./admin-audit");
import type { HubDb } from "../db";

function insertingDb(sink: Record<string, unknown>[], throwOnInsert = false) {
  return {
    insert() {
      return {
        values(v: Record<string, unknown>) {
          if (throwOnInsert) throw new Error("insert boom");
          sink.push(v);
          return Promise.resolve();
        },
      };
    },
  } as unknown as HubDb;
}

// A db whose sequential `select()` calls resolve to `results[0]`, `results[1]`,
// … in call order. `listAuditRecords` issues the count query first, then the
// rows query, so `results = [ [{ total }], rows ]`. Every chain method returns
// the thenable builder so `await` resolves to the queued result regardless of
// which of from/where/orderBy/limit/offset the query calls.
interface QueueCapture {
  wheres: unknown[];
  limits: number[];
  offsets: number[];
}

function queueDb(results: unknown[]): { db: HubDb; capture: QueueCapture } {
  let i = 0;
  const capture: QueueCapture = { wheres: [], limits: [], offsets: [] };
  const select = () => {
    const value = results[i++];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: (w: unknown) => {
        capture.wheres.push(w);
        return chain;
      },
      orderBy: () => chain,
      limit: (n: number) => {
        capture.limits.push(n);
        return chain;
      },
      offset: (n: number) => {
        capture.offsets.push(n);
        return chain;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(value).then(res, rej),
    };
    return chain;
  };
  return { db: { select } as unknown as HubDb, capture };
}

describe("recordAudit", () => {
  it("writes a row with the given action, actor, and target", async () => {
    const sink: Record<string, unknown>[] = [];
    await recordAudit({
      db: insertingDb(sink),
      tenantId: "ten_1",
      action: "activity_read",
      actorPrincipalId: "prn_actor",
      targetPrincipalId: "prn_target",
      resource: "activity:principal/read",
    });
    expect(sink[0]).toMatchObject({
      tenantId: "ten_1",
      action: "activity_read",
      actorPrincipalId: "prn_actor",
      targetPrincipalId: "prn_target",
      resource: "activity:principal/read",
    });
  });

  it("is best-effort: a write failure does not throw", async () => {
    await expect(
      recordAudit({
        db: insertingDb([], true),
        tenantId: "ten_1",
        action: "grant_created",
        actorPrincipalId: "prn_actor",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("listAuditRecords", () => {
  it("resolves actor/target names, serializes detail, returns filtered total", async () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    const { db, capture } = queueDb([
      [{ total: 1 }],
      [
        {
          id: "aud_1",
          action: "activity_read",
          actorPrincipalId: "prn_actor",
          targetPrincipalId: "prn_target",
          resource: "activity:principal/read",
          detail: { foo: "bar" },
          createdAt: now,
        },
      ],
    ]);
    const { records, total } = await listAuditRecords(db, "ten_1", {
      page: 1,
      limit: 25,
    });
    expect(total).toBe(1);
    expect(capture.limits).toEqual([25]);
    expect(capture.offsets).toEqual([0]);
    expect(records[0]).toMatchObject({
      id: "aud_1",
      actorName: "Alice",
      targetName: "Bob",
      resource: "activity:principal/read",
      detail: JSON.stringify({ foo: "bar" }),
      createdAt: now.toISOString(),
    });
  });

  it("offsets by (page-1)*limit for a later page", async () => {
    const { db, capture } = queueDb([[{ total: 0 }], []]);
    await listAuditRecords(db, "ten_1", {
      page: 3,
      limit: 10,
      actor: "prn_actor",
      action: "role_assigned",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(capture.limits).toEqual([10]);
    expect(capture.offsets).toEqual([20]);
    // Count query + rows query each built one where clause.
    expect(capture.wheres.length).toBe(2);
  });
});
