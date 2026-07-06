import { describe, expect, it } from "bun:test";
import {
  assignRole,
  findAdminRoleId,
  listTenantPrincipals,
  listWorkflowDefinitionSummaries,
  principalExistsInTenant,
  removeRole,
  RoleNotFoundError,
} from "./admin-governance";
import type { HubDb } from "../db";

// A db whose sequential `select()` calls resolve to `results[0]`, `results[1]`,
// … in call order. Every chain method returns the thenable builder so `await`
// resolves to the queued array regardless of which of
// from/innerJoin/where/orderBy the query calls.
function selectQueueDb(results: unknown[]): HubDb {
  let i = 0;
  const select = () => {
    const value = results[i++];
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(value).then(res, rej),
    };
    return chain;
  };
  return { select } as unknown as HubDb;
}

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

describe("listWorkflowDefinitionSummaries (ephemeral exclusion)", () => {
  it("keeps only catalog kinds, dropping per-run supervisor/step rows", async () => {
    // The `workflow_run` index as it looks at data volume: a real definition
    // plus the junk unvalidated direct deploys wrote — a per-run supervisor and
    // bare workflow steps.
    const rows = [
      {
        kind: "supervisor-ses_abc123",
        status: "running",
        meta: null,
        deletedAt: null,
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
      },
      {
        kind: "skipWriteBack",
        status: "running",
        meta: null,
        deletedAt: null,
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        kind: "source-selection",
        status: "running",
        meta: null,
        deletedAt: null,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        kind: "brief-builder",
        status: "running",
        meta: { version: "3", label: "Brief Builder" },
        deletedAt: null,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ];
    const db = selectQueueDb([rows]);
    const result = await listWorkflowDefinitionSummaries(
      db,
      "ten_1",
      new Set(["brief-builder"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "workflow",
      key: "brief-builder",
      name: "Brief Builder",
      version: "3",
    });
  });

  it("groups redeploys of one kind into a single row with a deployment count", async () => {
    const rows = [
      {
        kind: "brief-builder",
        status: "running",
        meta: { version: "3" },
        deletedAt: null,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        kind: "brief-builder",
        status: "superseded",
        meta: { version: "2" },
        deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        kind: "brief-builder",
        status: "superseded",
        meta: { version: "1" },
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const db = selectQueueDb([rows]);
    const result = await listWorkflowDefinitionSummaries(
      db,
      "ten_1",
      new Set(["brief-builder"]),
    );
    expect(result).toHaveLength(1);
    // Newest row is the representative; every deploy of the kind is counted.
    expect(result[0]).toMatchObject({ version: "3", deploymentCount: 3 });
  });
});

describe("listTenantPrincipals (filter + pagination)", () => {
  // gatherTenantPrincipals issues three selects in order: rolesByPrincipal,
  // user rows, agent rows.
  function seededDb() {
    const roleRows: unknown[] = [];
    const userRows = [
      {
        id: "prn_u1",
        refId: "usr_1",
        status: "active",
        name: "Alice",
        email: "alice@x.com",
      },
      {
        id: "prn_u2",
        refId: "usr_2",
        status: "active",
        name: "Bob",
        email: "bob@x.com",
      },
    ];
    const agentRows = [
      { id: "prn_a1", refId: "ins_1", status: "active", name: "Myra" },
    ];
    return selectQueueDb([roleRows, userRows, agentRows]);
  }

  it("paginates: page 1 limit 2 returns 2 of 3, total reflects the full set", async () => {
    const { principals, total } = await listTenantPrincipals(seededDb(), "t", {
      page: 1,
      limit: 2,
    });
    expect(total).toBe(3);
    expect(principals).toHaveLength(2);
  });

  it("page 2 returns the remaining principal", async () => {
    const { principals } = await listTenantPrincipals(seededDb(), "t", {
      page: 2,
      limit: 2,
    });
    expect(principals).toHaveLength(1);
  });

  it("type filter narrows to agent-instance principals", async () => {
    const { principals, total } = await listTenantPrincipals(seededDb(), "t", {
      page: 1,
      limit: 25,
      type: "agent",
    });
    expect(total).toBe(1);
    expect(principals.every((p) => p.kind === "agent")).toBe(true);
  });

  it("search filter narrows by display name", async () => {
    const { principals, total } = await listTenantPrincipals(seededDb(), "t", {
      page: 1,
      limit: 25,
      search: "ali",
    });
    expect(total).toBe(1);
    expect(principals[0]?.displayName).toBe("Alice");
  });
});
