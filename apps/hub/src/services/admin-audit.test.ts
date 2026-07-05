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

function selectingDb(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as HubDb;
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
  it("resolves actor/target names and serializes detail + timestamps", async () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    const db = selectingDb([
      {
        id: "aud_1",
        action: "activity_read",
        actorPrincipalId: "prn_actor",
        targetPrincipalId: "prn_target",
        resource: "activity:principal/read",
        detail: { foo: "bar" },
        createdAt: now,
      },
    ]);
    const records = await listAuditRecords(db, "ten_1");
    expect(records[0]).toMatchObject({
      id: "aud_1",
      actorName: "Alice",
      targetName: "Bob",
      resource: "activity:principal/read",
      detail: JSON.stringify({ foo: "bar" }),
      createdAt: now.toISOString(),
    });
  });
});
