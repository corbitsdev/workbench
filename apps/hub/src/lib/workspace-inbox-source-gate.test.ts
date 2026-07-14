import { describe, expect, test } from "bun:test";
import { workspaceInboxSourceResource } from "@workbench/shared";
import {
  isInboxSourceEnabledFromGrants,
  setWorkspaceInboxSourceGrant,
} from "./workspace-inbox-source-gate";
import type { HubDb } from "../db";

// CL-3584: the owner-level inbox source grant covers BOTH scopes. These exercise
// the grant evaluation (deny-by-default) and the toggle CRUD over a fake tx.

function allowGrant(sourceKey: string) {
  return {
    id: `grt_${sourceKey}`,
    resource: workspaceInboxSourceResource(sourceKey),
    action: "enable",
    effect: "allow" as const,
    origin: "system" as const,
    conditions: null,
    expiresAt: null,
    roleId: "rol_member",
    principalId: null,
  };
}

describe("isInboxSourceEnabledFromGrants", () => {
  test("deny-by-default: no grant means disabled", async () => {
    expect(await isInboxSourceEnabledFromGrants([], "granola")).toBe(false);
  });

  test("an allow grant for the source enables it", async () => {
    expect(
      await isInboxSourceEnabledFromGrants([allowGrant("granola")], "granola"),
    ).toBe(true);
  });

  test("a grant for a different source does not enable this one", async () => {
    expect(
      await isInboxSourceEnabledFromGrants([allowGrant("linear")], "granola"),
    ).toBe(false);
  });
});

describe("setWorkspaceInboxSourceGrant", () => {
  function fakeDb(opts: { existing?: boolean } = {}) {
    const inserted: Record<string, unknown>[] = [];
    let deletes = 0;
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [] }) }),
      }),
      query: {
        grant: {
          findFirst: async () =>
            opts.existing ? { id: "grt_existing" } : undefined,
        },
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          inserted.push(vals);
          return Promise.resolve();
        },
      }),
      delete: () => ({
        where: () => {
          deletes += 1;
          return Promise.resolve();
        },
      }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as HubDb;
    return { db, inserted, deletes: () => deletes };
  }

  test("enable writes an allow grant when none exists", async () => {
    const { db, inserted } = fakeDb();
    await setWorkspaceInboxSourceGrant(db, {
      tenantId: "ten_root",
      roleId: "rol_member",
      sourceKey: "granola",
      enabled: true,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      resource: "inbox-source:granola",
      action: "enable",
      effect: "allow",
      roleId: "rol_member",
    });
  });

  test("enable is idempotent when the grant already exists", async () => {
    const { db, inserted } = fakeDb({ existing: true });
    await setWorkspaceInboxSourceGrant(db, {
      tenantId: "ten_root",
      roleId: "rol_member",
      sourceKey: "granola",
      enabled: true,
    });
    expect(inserted).toHaveLength(0);
  });

  test("disable removes the existing grant", async () => {
    const { db, deletes } = fakeDb({ existing: true });
    await setWorkspaceInboxSourceGrant(db, {
      tenantId: "ten_root",
      roleId: "rol_member",
      sourceKey: "granola",
      enabled: false,
    });
    expect(deletes()).toBe(1);
  });

  test("disable is a no-op when no grant exists", async () => {
    const { db, deletes } = fakeDb();
    await setWorkspaceInboxSourceGrant(db, {
      tenantId: "ten_root",
      roleId: "rol_member",
      sourceKey: "granola",
      enabled: false,
    });
    expect(deletes()).toBe(0);
  });
});
