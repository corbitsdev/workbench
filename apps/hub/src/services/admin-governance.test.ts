import { describe, expect, it } from "bun:test";
import {
  assignRole,
  findAdminRoleId,
  principalExistsInTenant,
  removeRole,
  RoleNotFoundError,
} from "./admin-governance";
import type { HubDb } from "../db";

// A minimal fake of the drizzle query builder covering only the chains these
// service functions use. Captures inserts/deletes so the test asserts the
// column mapping the functions produce (not a tautology — a wrong column name
// would change the captured value).

interface Captured {
  inserts: Record<string, unknown>[];
  deletes: number;
}

function fakeDb(opts: {
  roleRow?: { id: string; tenantId: string; name: string } | undefined;
  principalRow?: { id: string } | undefined;
}): { db: HubDb; captured: Captured } {
  const captured: Captured = { inserts: [], deletes: 0 };
  const db = {
    insert() {
      return {
        values(values: Record<string, unknown>) {
          captured.inserts.push(values);
          return { onConflictDoNothing: () => Promise.resolve() };
        },
      };
    },
    delete() {
      return {
        where() {
          captured.deletes += 1;
          return Promise.resolve();
        },
      };
    },
    query: {
      role: { findFirst: () => Promise.resolve(opts.roleRow) },
      principal: { findFirst: () => Promise.resolve(opts.principalRow) },
    },
  } as unknown as HubDb;
  return { db, captured };
}

describe("assignRole", () => {
  it("inserts a principal_role row when the role exists in the tenant", async () => {
    const { db, captured } = fakeDb({
      roleRow: { id: "rol_admin", tenantId: "ten_1", name: "admin" },
    });
    await assignRole(db, "ten_1", "prn_target", "rol_admin");
    expect(captured.inserts[0]).toMatchObject({
      principalId: "prn_target",
      roleId: "rol_admin",
    });
  });

  it("throws RoleNotFoundError when the role is absent", async () => {
    const { db } = fakeDb({ roleRow: undefined });
    await expect(
      assignRole(db, "ten_1", "prn_target", "rol_missing"),
    ).rejects.toBeInstanceOf(RoleNotFoundError);
  });
});

describe("removeRole", () => {
  it("deletes the principal_role assignment", async () => {
    const { db, captured } = fakeDb({});
    await removeRole(db, "prn_target", "rol_admin");
    expect(captured.deletes).toBe(1);
  });
});

describe("findAdminRoleId", () => {
  it("returns the admin role id when present", async () => {
    const { db } = fakeDb({
      roleRow: { id: "rol_admin", tenantId: "ten_1", name: "admin" },
    });
    expect(await findAdminRoleId(db, "ten_1")).toBe("rol_admin");
  });

  it("returns null when no admin role exists", async () => {
    const { db } = fakeDb({ roleRow: undefined });
    expect(await findAdminRoleId(db, "ten_1")).toBeNull();
  });
});

describe("principalExistsInTenant", () => {
  it("is true when the principal row exists in the tenant", async () => {
    const { db } = fakeDb({ principalRow: { id: "prn_1" } });
    expect(await principalExistsInTenant(db, "ten_1", "prn_1")).toBe(true);
  });

  it("is false for an unknown/foreign principal", async () => {
    const { db } = fakeDb({ principalRow: undefined });
    expect(await principalExistsInTenant(db, "ten_1", "prn_x")).toBe(false);
  });
});
