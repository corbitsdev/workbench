import { describe, expect, it, mock } from "bun:test";

const GLOBAL_TENANT = {
  slug: "acme",
  name: "Acme Inc",
  domain: "acme.example.com",
};

mock.module("../config", () => ({
  getConfig: () => ({
    exa: { apiKey: undefined },
    rootTenant: GLOBAL_TENANT,
  }),
  loadConfig: () => ({
    exa: { apiKey: undefined },
    rootTenant: GLOBAL_TENANT,
  }),
}));

const refreshInstanceGrantsMock = mock(() =>
  Promise.resolve({ refreshed: true, pushed: false }),
);
mock.module("../services/grant-reconcile", () => ({
  refreshInstanceGrantsFromDefinition: refreshInstanceGrantsMock,
}));

import {
  provisionMemberInstances,
  getMyraInstanceId,
  seedGlobalTenant,
  seedAgentTemplates,
  ensureSystemPrincipal,
  ensureMember,
  autoJoinConfiguredTenants,
  lookupMember,
  resolveCallerMember,
  getEnabledTemplateKeys,
  agentDefMatchesTemplate,
  reseedAgentTemplateIfStale,
  type ProvisioningDB,
} from "./tenant-provisioning";
import { AGENT_TEMPLATES, templateModelRequirements } from "@workbench/agents";

// Build a mock DB that satisfies the ProvisioningDB structural type including
// the transaction contract (immediately calls the callback with itself).
// biome-ignore lint/suspicious/noExplicitAny: test mock — overrides may omit
// query keys (e.g. memberAgentInstance), which are merged in from the defaults.
function makeMockDB(overrides: any = {}): ProvisioningDB {
  let base: ProvisioningDB;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const txMock = mock((fn: (tx: ProvisioningDB) => Promise<unknown>) =>
    fn(base),
  ) as any;
  const defaultQuery = {
    tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
    principal: { findFirst: mock(() => Promise.resolve(undefined)) },
    role: { findFirst: mock(() => Promise.resolve(undefined)) },
    // Default to an EXISTING system-principal credential-use grant so
    // `ensureSystemPrincipal`'s idempotent grant-ensure is a no-op in tests that
    // are not exercising it (it only queries `grant.findFirst`); a test that
    // wants the insert path overrides this to resolve undefined.
    grant: { findFirst: mock(() => Promise.resolve({ id: "grt_existing" })) },
    agent: {
      findFirst: mock(() => Promise.resolve(undefined)),
      findMany: mock(() => Promise.resolve([])),
    },
    agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
    memberAgentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
    provider: { findFirst: mock(() => Promise.resolve(undefined)) },
  };
  const { query: queryOverride, ...rest } = overrides;
  // Deep-merge query overrides at the method level so tests can override
  // findFirst without accidentally dropping findMany (and vice versa).
  const mergedQuery = { ...defaultQuery } as Record<
    string,
    Record<string, unknown>
  >;
  for (const [table, methods] of Object.entries(queryOverride ?? {})) {
    mergedQuery[table] = {
      ...(defaultQuery as Record<string, Record<string, unknown>>)[table],
      ...(methods as Record<string, unknown>),
    };
  }
  base = {
    transaction: txMock,
    query: mergedQuery,
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => Promise.resolve()),
    })),
    ...rest,
  };
  return base;
}

describe("provisionMemberInstances", () => {
  const GLOBAL = { id: "tnt_global", slug: "acme" };
  const MEMBER_PRINCIPAL = "prn_member";
  const USER_ID = "user-abc";
  // The shared org-level Myra definition seeded by CL-1530 (keyed on name).
  const MYRA_DEF = { id: "agt_myra_def", name: "Myra" };

  function makeCapturingDb(opts: {
    agentFind?: () => Promise<unknown>;
    mappingFind?: () => Promise<unknown>;
    agentInstanceFind?: () => Promise<unknown>;
    insertThrows?: (row: Record<string, unknown>) => boolean;
  }) {
    const inserted: Record<string, unknown>[] = [];
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        if (opts.insertThrows?.(row)) {
          throw Object.assign(
            new Error("duplicate key value violates unique constraint"),
            {
              code: "23505",
            },
          );
        }
        return {
          returning: mock(() => Promise.resolve([{ id: row.id }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        agent: {
          findFirst: mock(opts.agentFind ?? (() => Promise.resolve(MYRA_DEF))),
        },
        agentInstance: {
          findFirst: mock(
            opts.agentInstanceFind ?? (() => Promise.resolve(undefined)),
          ),
        },
        memberAgentInstance: {
          findFirst: mock(
            opts.mappingFind ?? (() => Promise.resolve(undefined)),
          ),
        },
      },
      insert: insertMock,
    });
    return { db, inserted, insertMock };
  }

  it("creates one instance + mapping per enabled template (default Myra)", async () => {
    const { db, inserted } = makeCapturingDb({});

    const result = await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(result.map((r) => r.templateKey)).toEqual(["myra"]);
    expect(result[0]?.instanceId).toBeDefined();

    // The instance references the SHARED org definition, not a new one.
    const instanceRow = inserted.find(
      (r) => r.agentId !== undefined && "address" in r,
    );
    expect(instanceRow?.agentId).toBe(MYRA_DEF.id);

    // The mapping row attributes the instance to the member principal.
    const mappingRow = inserted.find((r) => r.memberPrincipalId !== undefined);
    expect(mappingRow?.memberPrincipalId).toBe(MEMBER_PRINCIPAL);
    expect(mappingRow?.templateKey).toBe("myra");
    expect(mappingRow?.agentId).toBe(MYRA_DEF.id);
    expect(mappingRow?.tenantId).toBe("tnt_global");

    // No new agent DEFINITION is created — instances reference the seeded def.
    const agentDefRow = inserted.find((r) => r.systemPrompt !== undefined);
    expect(agentDefRow).toBeUndefined();
  });

  it("grants the owning member read/write/manage on their own instance (CL-1635)", async () => {
    const { db, inserted } = makeCapturingDb({});

    await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    const instanceRow = inserted.find(
      (r) => r.agentId !== undefined && "address" in r,
    );
    const instanceId = instanceRow?.id as string;
    expect(instanceId).toBeDefined();

    const instanceGrants = inserted.filter(
      (r) =>
        r.principalId === MEMBER_PRINCIPAL &&
        r.resource === `instance:${instanceId}` &&
        r.action !== undefined,
    );
    expect(instanceGrants.map((g) => g.action).sort()).toEqual([
      "manage",
      "read",
      "write",
    ]);
    for (const g of instanceGrants) {
      expect(g.effect).toBe("allow");
      expect(g.tenantId).toBe("tnt_global");
      expect(g.roleId).toBeUndefined();
    }
  });

  it("is idempotent — existing mapping + instance means no new insert", async () => {
    refreshInstanceGrantsMock.mockClear();
    const { db, insertMock } = makeCapturingDb({
      mappingFind: () =>
        Promise.resolve({ id: "mai_1", instanceId: "ins_existing" }),
      agentInstanceFind: () => Promise.resolve({ id: "ins_existing" }),
    });

    const result = await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(result).toEqual([
      { templateKey: "myra", instanceId: "ins_existing" },
    ]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(refreshInstanceGrantsMock).toHaveBeenCalledTimes(1);
  });

  it("recreates the instance when the mapping exists but its instance is gone", async () => {
    const { db, inserted, insertMock } = makeCapturingDb({
      mappingFind: () =>
        Promise.resolve({ id: "mai_1", instanceId: "ins_dead" }),
      agentInstanceFind: () => Promise.resolve(undefined),
    });

    const result = await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(insertMock).toHaveBeenCalled();
    expect(result[0]?.instanceId).not.toBe("ins_dead");
    expect(inserted.some((r) => "address" in r)).toBe(true);
  });

  it("skips a template whose shared org definition is missing (no throw)", async () => {
    const { db, insertMock } = makeCapturingDb({
      agentFind: () => Promise.resolve(undefined),
    });

    const result = await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(result).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("is race-safe — reselects the mapping on a unique violation", async () => {
    let mappingCalls = 0;
    const { db } = makeCapturingDb({
      mappingFind: () => {
        mappingCalls += 1;
        // Pre-check finds nothing; the post-conflict reselect finds the raced row.
        return Promise.resolve(
          mappingCalls >= 2
            ? { id: "mai_raced", instanceId: "ins_raced" }
            : undefined,
        );
      },
      insertThrows: (row) => row.memberPrincipalId !== undefined,
    });

    const result = await provisionMemberInstances(db as never, {
      tenantId: GLOBAL.id,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(result).toEqual([{ templateKey: "myra", instanceId: "ins_raced" }]);
  });

  it("provisions instances into the GIVEN (non-root) tenant", async () => {
    const CHILD = "tnt_child";
    const { db, inserted } = makeCapturingDb({});

    const result = await provisionMemberInstances(db as never, {
      tenantId: CHILD,
      userId: USER_ID,
      memberPrincipalId: MEMBER_PRINCIPAL,
    });

    expect(result.map((r) => r.templateKey)).toEqual(["myra"]);
    const mappingRow = inserted.find((r) => r.memberPrincipalId !== undefined);
    expect(mappingRow?.tenantId).toBe(CHILD);
    const instanceRow = inserted.find(
      (r) => r.agentId !== undefined && "address" in r,
    );
    expect(instanceRow?.tenantId).toBe(CHILD);
  });
});

describe("getMyraInstanceId", () => {
  it("returns the Myra mapping instance id", () => {
    expect(
      getMyraInstanceId([
        { templateKey: "oat", instanceId: "ins_oat" },
        { templateKey: "myra", instanceId: "ins_myra" },
      ]),
    ).toBe("ins_myra");
  });

  it("returns null when Myra is not present", () => {
    expect(
      getMyraInstanceId([{ templateKey: "oat", instanceId: "ins_oat" }]),
    ).toBeNull();
  });
});

describe("seedGlobalTenant", () => {
  // Capture every inserted row so we can classify role and grant rows.
  function makeCapturingDB(opts: {
    tenantFindResults: ({ id: string; slug: string } | undefined)[];
    insertThrowsOnTenant?: boolean;
  }) {
    const inserted: Record<string, unknown>[] = [];
    const tenantFindResults = [...opts.tenantFindResults];
    const tenantFind = mock(() => Promise.resolve(tenantFindResults.shift()));

    let tenantInsertCount = 0;
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        // The tenant row is the only one read back via .returning().
        const isTenant = typeof row.slug === "string";
        if (isTenant) {
          tenantInsertCount += 1;
          if (opts.insertThrowsOnTenant) {
            throw Object.assign(
              new Error("duplicate key value violates unique constraint"),
              {
                code: "23505",
              },
            );
          }
        }
        return {
          returning: mock(() =>
            Promise.resolve(
              isTenant ? [{ id: "tnt_global", slug: row.slug }] : [],
            ),
          ),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));

    const base = makeMockDB({
      query: {
        tenant: { findFirst: tenantFind },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });
    return {
      db: base,
      inserted,
      get tenantInsertCount() {
        return tenantInsertCount;
      },
    };
  }

  function classify(inserted: Record<string, unknown>[]) {
    const roles = inserted.filter((r) => r.isSystem !== undefined);
    const grants = inserted.filter(
      (r) => r.resource !== undefined && r.action !== undefined,
    );
    const roleNameById = new Map<string, string>();
    for (const r of roles) roleNameById.set(r.id as string, r.name as string);
    return { roles, grants, roleNameById };
  }

  it("creates the global tenant from config when it does not exist", async () => {
    const { db, inserted } = makeCapturingDB({
      tenantFindResults: [undefined],
    });
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe("tnt_global");
    const tenantRow = inserted.find((r) => typeof r.slug === "string");
    expect(tenantRow?.slug).toBe("acme");
    expect(tenantRow?.name).toBe("Acme Inc");
    expect(tenantRow?.domain).toBe("acme.example.com");
    expect(tenantRow?.parentId).toBeNull();
  });

  it("is idempotent — returns the existing tenant without inserting", async () => {
    const { db, inserted } = makeCapturingDB({
      tenantFindResults: [{ id: "tnt_existing", slug: "acme" }],
    });
    // Existing tenant has its system roles — the member-role check passes.
    db.query.role.findFirst = mock(() => Promise.resolve({ id: "rol_member" }));
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe("tnt_existing");
    expect(inserted.length).toBe(0);
  });

  it("fails loud if the existing tenant is missing its system roles", async () => {
    const { db } = makeCapturingDB({
      tenantFindResults: [{ id: "tnt_existing", slug: "acme" }],
    });
    // role.findFirst defaults to undefined → member role missing → must throw.
    await expect(seedGlobalTenant(db as never)).rejects.toThrow(
      /missing its system roles/,
    );
  });

  it("is race-safe — reselects the tenant when the insert hits a unique violation", async () => {
    // First findFirst (pre-check) returns nothing, the insert throws a unique
    // violation, the catch-block reselect finds the row a concurrent boot created.
    const { db } = makeCapturingDB({
      tenantFindResults: [undefined, { id: "tnt_raced", slug: "acme" }],
      insertThrowsOnTenant: true,
    });
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe("tnt_raced");
  });

  it("seeds owner and admin grants but NOT a member grant", async () => {
    const { db, inserted } = makeCapturingDB({
      tenantFindResults: [undefined],
    });
    await seedGlobalTenant(db as never);
    const { grants, roleNameById } = classify(inserted);

    const memberRoleId = [...roleNameById.entries()].find(
      ([, name]) => name === "member",
    )?.[0];
    const ownerRoleId = [...roleNameById.entries()].find(
      ([, name]) => name === "owner",
    )?.[0];
    const adminRoleId = [...roleNameById.entries()].find(
      ([, name]) => name === "admin",
    )?.[0];
    expect(memberRoleId).toBeDefined();

    // No grant references the member role.
    expect(grants.some((g) => g.roleId === memberRoleId)).toBe(false);

    // Owner keeps *:* and admin keeps read/create/manage.
    expect(
      grants.some(
        (g) =>
          g.roleId === ownerRoleId && g.resource === "*" && g.action === "*",
      ),
    ).toBe(true);
    const adminActions = grants
      .filter((g) => g.roleId === adminRoleId)
      .map((g) => g.action)
      .sort();
    expect(adminActions).toEqual(["create", "manage", "read"]);
  });
});

describe("ensureMember", () => {
  // A NON-root tenant id, to prove the wrapper operates on whatever tenant it
  // is given rather than the configured root.
  const TENANT_ID = "tnt_child";

  it("is idempotent — returns the existing principal without inserting", async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));
    const db = makeMockDB({
      query: {
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_existing" })),
        },
      },
      insert: insertMock,
    });

    const result = await ensureMember(db as never, {
      tenantId: TENANT_ID,
      userId: "user-abc",
    });
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.principalId).toBe("prn_existing");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("creates a user principal in the GIVEN tenant and assigns NO role", async () => {
    const inserted: Record<string, unknown>[] = [];
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        return {
          returning: mock(() => Promise.resolve([{ id: "prn_new" }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureMember(db as never, {
      tenantId: TENANT_ID,
      userId: "user-abc",
    });
    expect(result.tenantId).toBe(TENANT_ID);

    // The principal is created in the tenant we passed, not the configured root.
    const principalRow = inserted.find((r) => r.kind === "user");
    expect(principalRow?.refId).toBe("user-abc");
    expect(principalRow?.tenantId).toBe(TENANT_ID);

    // No role is assigned on join — membership is the principal row alone.
    const roleAssignment = inserted.find((r) => r.roleId !== undefined);
    expect(roleAssignment).toBeUndefined();
  });

  it("is race-safe — reselects the principal when the insert hits a unique violation", async () => {
    let principalFindCalls = 0;
    const principalFind = mock(() => {
      principalFindCalls += 1;
      return Promise.resolve(
        principalFindCalls >= 2 ? { id: "prn_raced" } : undefined,
      );
    });
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        if (row.kind === "user") {
          throw Object.assign(
            new Error("duplicate key value violates unique constraint"),
            {
              code: "23505",
            },
          );
        }
        return {
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: { principal: { findFirst: principalFind } },
      insert: insertMock,
    });

    const result = await ensureMember(db as never, {
      tenantId: TENANT_ID,
      userId: "user-abc",
    });
    expect(result.principalId).toBe("prn_raced");
  });
});

describe("lookupMember", () => {
  const TENANT_ID = "tnt_child";

  it("returns membership in the given tenant when the principal exists", async () => {
    const db = makeMockDB({
      query: {
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_found" })),
        },
      },
    });
    const result = await lookupMember(db as never, {
      tenantId: TENANT_ID,
      userId: "user-abc",
    });
    expect(result).toEqual({ tenantId: TENANT_ID, principalId: "prn_found" });
  });

  it("returns null when the user has no principal in the given tenant", async () => {
    const db = makeMockDB({
      query: {
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
    const result = await lookupMember(db as never, {
      tenantId: TENANT_ID,
      userId: "user-abc",
    });
    expect(result).toBeNull();
  });
});

describe("resolveCallerMember", () => {
  it("resolves the caller to their principal in the root tenant", async () => {
    const db = makeMockDB({
      query: {
        tenant: {
          findFirst: mock(() => Promise.resolve({ id: "tnt_root" })),
        },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_me" })),
        },
      },
    });
    const result = await resolveCallerMember(db as never, "user-abc");
    expect(result).toEqual({ tenantId: "tnt_root", principalId: "prn_me" });
  });

  it("returns null when the root tenant is unseeded", async () => {
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
    const result = await resolveCallerMember(db as never, "user-abc");
    expect(result).toBeNull();
  });

  it("returns null when the caller has no membership", async () => {
    const db = makeMockDB({
      query: {
        tenant: {
          findFirst: mock(() => Promise.resolve({ id: "tnt_root" })),
        },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
    const result = await resolveCallerMember(db as never, "user-abc");
    expect(result).toBeNull();
  });
});

describe("ensureSystemPrincipal", () => {
  it("is idempotent — returns the existing system principal without inserting", async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureSystemPrincipal(db as never, "tnt_global");
    expect(result.principalId).toBe("prn_system");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("creates the system principal when none exists", async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureSystemPrincipal(db as never, "tnt_global");
    expect(result.principalId).toMatch(/^prn/);
    expect(insertMock).toHaveBeenCalled();
  });

  it("is race-safe — reselects on a unique violation", async () => {
    let findCalls = 0;
    const insertMock = mock(() => ({
      values: mock(() => {
        throw new Error("duplicate key value violates unique constraint");
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: {
          findFirst: mock(() => {
            findCalls += 1;
            // First pre-check returns nothing; reselect after conflict finds it.
            return Promise.resolve(
              findCalls === 1 ? undefined : { id: "prn_raced" },
            );
          }),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureSystemPrincipal(db as never, "tnt_global");
    expect(result.principalId).toBe("prn_raced");
  });
});

describe("seedAgentTemplates", () => {
  const GLOBAL = { id: "tnt_global", slug: "acme" };
  // A NON-root tenant id, to prove the wrapper seeds wherever it is pointed.
  const CHILD_TENANT = "tnt_child";

  it("seeds templates into the given (non-root) tenant", async () => {
    const agentInserts: Record<string, unknown>[] = [];
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        agent: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([])),
        },
      },
      insert: mock(() => ({
        values: mock((vals: Record<string, unknown>) => {
          if (!("version" in vals)) agentInserts.push(vals);
          return {
            returning: mock(() => Promise.resolve([{ id: vals["id"] }])),
            onConflictDoNothing: mock(() => Promise.resolve([])),
          };
        }),
      })),
    });

    await seedAgentTemplates(db as never, CHILD_TENANT);

    expect(agentInserts.length).toBe(AGENT_TEMPLATES.length);
    for (const row of agentInserts) {
      expect(row["tenantId"]).toBe(CHILD_TENANT);
    }
  });

  it("is idempotent — existing definitions are not re-inserted", async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{ id: "agt_x" }])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        // System principal already exists; every agent template already exists.
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: {
          findFirst: mock(() =>
            Promise.resolve({ id: "agt_existing", name: "Myra" }),
          ),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    await seedAgentTemplates(db as never, GLOBAL.id);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts one agent row per template, owned by the system principal", async () => {
    const agentInserts: Record<string, unknown>[] = [];
    const versionInserts: Record<string, unknown>[] = [];
    const insertMock = mock(() => ({
      values: mock((vals: Record<string, unknown>) => {
        if ("version" in vals) {
          versionInserts.push(vals);
        } else {
          agentInserts.push(vals);
        }
        return {
          returning: mock(() => Promise.resolve([{ id: vals["id"] }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        // System principal already exists so no principal insert is counted here.
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    await seedAgentTemplates(db as never, GLOBAL.id);

    expect(agentInserts.length).toBe(AGENT_TEMPLATES.length);
    expect(versionInserts.length).toBe(AGENT_TEMPLATES.length);
    for (const row of agentInserts) {
      expect(row["creatorPrincipalId"]).toBe("prn_system");
      expect(row["tenantId"]).toBe("tnt_global");
      expect(row["status"]).toBe("deployed");
      expect(row["currentVersion"]).toBe("1");
    }
    const names = agentInserts.map((r) => r["name"]).sort();
    expect(names).toEqual(AGENT_TEMPLATES.map((t) => t.name).sort());

    // Each seeded definition carries its template description so list_agents
    // can surface what every agent is for (CL-1783).
    for (const template of AGENT_TEMPLATES) {
      const row = agentInserts.find((r) => r["name"] === template.name);
      expect(row?.["description"]).toBe(template.description);
    }

    // toolPackages must be persisted on every insert so the native Interchange
    // launch path (POST /instances) picks them up from parseAgentRow(row).toolPackages
    // rather than relying on the in-memory toolPackagePinsForAgentName lookup.
    for (const template of AGENT_TEMPLATES) {
      const row = agentInserts.find((r) => r["name"] === template.name);
      expect(row?.["toolPackages"]).toEqual(template.toolPackages ?? []);
    }
  });

  it("persists toolPackages on update for every agent template", async () => {
    const updateCapture: Record<string, unknown>[] = [];
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: {
          findFirst: mock(() =>
            Promise.resolve({
              id: "agt_myra",
              name: "Myra",
              modelConfig: null,
            }),
          ),
          findMany: mock(() => Promise.resolve([])),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      update: mock(() => ({
        set: mock((vals: Record<string, unknown>) => {
          updateCapture.push(vals);
          return { where: mock(() => Promise.resolve()) };
        }),
      })),
    });

    await seedAgentTemplates(db as never, GLOBAL.id);

    // All templates trigger the update path (mock returns existing for every findFirst).
    // Updates fire in AGENT_TEMPLATES order, so index alignment is stable.
    expect(updateCapture).toHaveLength(AGENT_TEMPLATES.length);
    for (let i = 0; i < AGENT_TEMPLATES.length; i++) {
      const template = AGENT_TEMPLATES[i]!;
      expect(updateCapture[i]?.["toolPackages"]).toEqual(
        template.toolPackages ?? [],
      );
    }
  });

  it("writes modelRequirements derived from each template on insert", async () => {
    const agentInserts: Record<string, unknown>[] = [];
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([])),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: mock(() => ({
        values: mock((vals: Record<string, unknown>) => {
          agentInserts.push(vals);
          return {
            returning: mock(() => Promise.resolve([{ id: vals["id"] }])),
          };
        }),
      })),
    });

    await seedAgentTemplates(db as never, GLOBAL.id);

    for (const template of AGENT_TEMPLATES) {
      const row = agentInserts.find((r) => r["name"] === template.name);
      const model = (template.modelConfig as { defaultModel: string })
        .defaultModel;
      expect(row?.["modelRequirements"]).toEqual([{ model }]);
    }
  });

  it("writes modelRequirements derived from each template on update", async () => {
    const updateCapture: Record<string, unknown>[] = [];
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_system" })),
        },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: {
          findFirst: mock(() =>
            Promise.resolve({
              id: "agt_existing",
              name: "Myra",
              modelConfig: null,
            }),
          ),
          findMany: mock(() => Promise.resolve([])),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      update: mock(() => ({
        set: mock((vals: Record<string, unknown>) => {
          updateCapture.push(vals);
          return { where: mock(() => Promise.resolve()) };
        }),
      })),
    });

    await seedAgentTemplates(db as never, GLOBAL.id);

    expect(updateCapture).toHaveLength(AGENT_TEMPLATES.length);
    for (let i = 0; i < AGENT_TEMPLATES.length; i++) {
      const template = AGENT_TEMPLATES[i]!;
      const model = (template.modelConfig as { defaultModel: string })
        .defaultModel;
      expect(updateCapture[i]?.["modelRequirements"]).toEqual([{ model }]);
    }
  });
});

describe("getEnabledTemplateKeys", () => {
  function makeTenantQueryDB(
    tenantRow: Record<string, unknown> | undefined,
  ): ProvisioningDB {
    return makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(tenantRow as never)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: {
          findFirst: mock(() => Promise.resolve({ id: "grt_existing" })),
        },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
  }

  it("defaults to [myra] when the config is unset", async () => {
    const db = makeTenantQueryDB({
      id: "tnt_global",
      slug: "acme",
      config: null,
    });

    const templates = await getEnabledTemplateKeys(db as never, "tnt_global");

    expect(templates.map((t) => t.key)).toEqual(["myra"]);
  });

  it("defaults to [myra] when enabledAgentTemplates is missing or empty", async () => {
    const db = makeTenantQueryDB({
      id: "tnt_global",
      slug: "acme",
      config: { enabledAgentTemplates: [] },
    });

    const templates = await getEnabledTemplateKeys(db as never, "tnt_global");

    expect(templates.map((t) => t.key)).toEqual(["myra"]);
  });

  it("respects a configured list, preserving AGENT_TEMPLATES order", async () => {
    const db = makeTenantQueryDB({
      id: "tnt_global",
      slug: "acme",
      config: { enabledAgentTemplates: ["oat", "myra"] },
    });

    const templates = await getEnabledTemplateKeys(db as never, "tnt_global");
    const keys = templates.map((t) => t.key).sort();

    expect(keys).toEqual(["myra", "oat"]);
    expect(templates.length).toBe(2);
  });

  it("drops unknown keys and keeps the known ones", async () => {
    const db = makeTenantQueryDB({
      id: "tnt_global",
      slug: "acme",
      config: { enabledAgentTemplates: ["myra", "does-not-exist"] },
    });

    const templates = await getEnabledTemplateKeys(db as never, "tnt_global");

    expect(templates.map((t) => t.key)).toEqual(["myra"]);
  });

  it("throws when the tenant row is not found", async () => {
    const db = makeTenantQueryDB(undefined);

    await expect(
      getEnabledTemplateKeys(db as never, "tnt_global"),
    ).rejects.toThrow(/not found/);
  });
});

describe("agentDefMatchesTemplate (CL-2517)", () => {
  const myra = AGENT_TEMPLATES.find((t) => t.key === "myra")!;
  const defFromTemplate = (
    overrides: Record<string, unknown> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test builds a partial agent row
  ): any => ({
    id: "agt_test",
    tenantId: "tnt_test",
    name: myra.name,
    description: myra.description,
    systemPrompt: myra.systemPrompt,
    capabilities: myra.capabilities,
    toolPackages: myra.toolPackages,
    credentialRequirements: myra.credentialRequirements,
    grantRequirements: myra.grantRequirements,
    modelRequirements: templateModelRequirements(myra),
    modelConfig: myra.modelConfig ?? null,
    ...overrides,
  });

  it("is true when the def equals the template on every seeded field", () => {
    expect(agentDefMatchesTemplate(defFromTemplate(), myra)).toBe(true);
  });

  it("is false when a tool package was dropped from the def (the actual bug)", () => {
    const stale = defFromTemplate({
      toolPackages: (myra.toolPackages ?? []).filter(
        (p) => !p.name.includes("linear"),
      ),
    });
    expect(agentDefMatchesTemplate(stale, myra)).toBe(false);
  });

  it("ignores jsonb object-key order (PG normalizes it) — no false drift", () => {
    const reordered = defFromTemplate({
      toolPackages: (myra.toolPackages ?? []).map((p) => ({
        version: p.version,
        name: p.name,
      })),
    });
    expect(agentDefMatchesTemplate(reordered, myra)).toBe(true);
  });

  it("is false when the system prompt drifts", () => {
    expect(
      agentDefMatchesTemplate(
        defFromTemplate({ systemPrompt: `${myra.systemPrompt} (edited)` }),
        myra,
      ),
    ).toBe(false);
  });
});

describe("reseedAgentTemplateIfStale (CL-2517)", () => {
  const myra = AGENT_TEMPLATES.find((t) => t.key === "myra")!;
  const fullDef = () => ({
    id: "agt_test",
    tenantId: "tnt_test",
    name: myra.name,
    description: myra.description,
    systemPrompt: myra.systemPrompt,
    capabilities: myra.capabilities,
    toolPackages: myra.toolPackages,
    credentialRequirements: myra.credentialRequirements,
    grantRequirements: myra.grantRequirements,
    modelRequirements: templateModelRequirements(myra),
    modelConfig: myra.modelConfig ?? null,
  });

  it("is a no-op when no def exists for the template", async () => {
    const db = makeMockDB();
    const res = await reseedAgentTemplateIfStale(db as never, "tnt_x", myra);
    expect(res).toEqual({ reseeded: false, agentId: null });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does NOT reseed or open a transaction when the def already matches", async () => {
    const db = makeMockDB({
      query: { agent: { findFirst: mock(() => Promise.resolve(fullDef())) } },
    });
    const res = await reseedAgentTemplateIfStale(db as never, "tnt_x", myra);
    expect(res).toEqual({ reseeded: false, agentId: "agt_test" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("reseeds the def with the template's toolPackages when it drifted", async () => {
    const stale = fullDef();
    stale.toolPackages = [];
    // Capture what the seed actually writes — assert the corrected toolPackages
    // land in the row, not merely that an update was issued.
    let written: Record<string, unknown> | null = null;
    const db = makeMockDB({
      query: {
        agent: { findFirst: mock(() => Promise.resolve(stale)) },
        principal: {
          findFirst: mock(() => Promise.resolve({ id: "prn_sys" })),
        },
      },
      update: mock(() => ({
        set: mock((values: Record<string, unknown>) => {
          written = values;
          return { where: mock(() => Promise.resolve()) };
        }),
      })),
    });
    const res = await reseedAgentTemplateIfStale(db as never, "tnt_x", myra);
    expect(res.reseeded).toBe(true);
    expect(res.agentId).toBe("agt_test");
    expect(written).not.toBeNull();
    expect(
      (written as unknown as { toolPackages: unknown }).toolPackages,
    ).toEqual(myra.toolPackages);
  });
});

describe("agentDefMatchesTemplate — every template round-trips clean (CL-2517)", () => {
  // A freshly-seeded def, once persisted as jsonb (simulated via a JSON
  // round-trip), MUST compare equal to its own template — otherwise the
  // self-heal would re-detect drift and rewrite on every thread create (a write
  // loop + relaunch churn). Covers all templates, not just Myra, so a future
  // template field that doesn't round-trip cleanly fails here loudly.
  for (const template of AGENT_TEMPLATES) {
    it(`'${template.key}' def equals its template after a jsonb round-trip`, () => {
      const stored = JSON.parse(
        JSON.stringify({
          description: template.description,
          systemPrompt: template.systemPrompt,
          capabilities: template.capabilities,
          toolPackages: template.toolPackages ?? [],
          credentialRequirements: template.credentialRequirements,
          grantRequirements: template.grantRequirements,
          modelRequirements: templateModelRequirements(template),
          modelConfig: template.modelConfig ?? null,
        }),
      );
      expect(agentDefMatchesTemplate(stored, template)).toBe(true);
    });
  }
});

describe("autoJoinConfiguredTenants (CL-2855)", () => {
  it("returns an empty list when no slugs are configured", async () => {
    const db = makeMockDB();
    const out = await autoJoinConfiguredTenants(db as never, "user-1", []);
    expect(out).toEqual([]);
  });

  it("skips unknown slugs without throwing", async () => {
    const db = makeMockDB();
    const out = await autoJoinConfiguredTenants(db as never, "user-1", [
      "missing-tenant",
    ]);
    expect(out).toEqual([]);
  });
});
