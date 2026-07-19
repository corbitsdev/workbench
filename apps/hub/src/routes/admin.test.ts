import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { GrantStore, GrantRule } from "@intx/authz";

// The guard resolves userId -> principalId via ensureMember; vary it per test.
let callerPrincipalId = "prn_member";
mock.module("../lib/tenant-provisioning", () => ({
  ensureMember: async () => ({
    tenantId: "ten_root",
    principalId: callerPrincipalId,
  }),
}));

const assignRole = mock(
  async (
    _db: unknown,
    _tenantId: string,
    _principalId: string,
    _roleId: string,
  ) => {},
);
const removeRole = mock(
  async (_db: unknown, _principalId: string, _roleId: string) => {},
);
let principalExists = true;
const principalExistsInTenant = mock(async () => principalExists);
const findAdminRoleId = mock(async () => "rol_admin" as string | null);
const listTenantRoles = mock(async () => [
  { id: "rol_admin", name: "admin", description: null, isSystem: true },
]);
const listTenantPrincipals = mock(
  async (): Promise<{ principals: unknown[]; total: number }> => ({
    principals: [],
    total: 0,
  }),
);
const listWorkflowDefinitionSummaries = mock(
  async (): Promise<unknown[]> => [],
);
const listAgentDefinitionSummaries = mock(async (): Promise<unknown[]> => []);
mock.module("../services/admin-governance", () => ({
  assignRole,
  removeRole,
  principalExistsInTenant,
  findAdminRoleId,
  listTenantRoles,
  listTenantPrincipals,
  getTenantPrincipal: mock(async () => null),
  getPrincipalGrants: mock(async () => ({
    principalId: "prn_x",
    isAdmin: false,
    roles: [],
    grants: [],
  })),
  listAgentDefinitionSummaries,
  listWorkflowDefinitionSummaries,
  getWorkflowDeploymentHistory: mock(async () => []),
  RoleNotFoundError: class extends Error {},
}));

mock.module("../lib/workflow-catalog", () => ({
  loadWorkflowCatalogKinds: mock(
    async () => new Set<string>(["brief-builder"]),
  ),
}));

mock.module("../lib/tenant-tools", () => ({
  listAvailableToolSummaries: mock(async () => []),
  resolveToolVersions: mock(async () => new Map<string, string>()),
}));

const recordAudit = mock(async () => {});
mock.module("../services/admin-audit", () => ({
  recordAudit,
  listAuditRecords: mock(async () => ({ records: [], total: 0 })),
}));

const { createAdminRouter } = await import("./admin");

// Real @intx/authz evaluation over a fake grant store: an admin principal holds
// a wildcard `*`/`*` allow grant (what the `owner`/`admin` system roles carry),
// a member holds none. The guard's isAdmin() -> authorize() runs for real, so
// this exercises the route -> guard -> grant-evaluation seam end to end.
function grantStoreFor(): GrantStore {
  const collectGrants = async (
    principalId: string,
  ): Promise<GrantRule[]> => {
    if (principalId !== "prn_admin") return [];
    return [
      {
        id: "grt_admin",
        resource: "*",
        action: "*",
        effect: "allow" as const,
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: "prn_admin",
      },
    ];
  };
  return { collectGrants, collectGrantsInChain: collectGrants };
}

function buildApp() {
  const db = {} as never;
  const assetService = {} as never;
  const app = new Hono<{
    Variables: { userId: string; userName: string; adminPrincipalId: string };
  }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createAdminRouter({
      db,
      grantStore: grantStoreFor(),
      assetService,
      rootTenantId: "ten_root",
    }),
  );
  return app;
}

describe("admin grant gate", () => {
  it("denies a non-admin with 403 on a read route", async () => {
    callerPrincipalId = "prn_member";
    const res = await buildApp().request("/admin/roles");
    expect(res.status).toBe(403);
  });

  it("allows an admin (holds wildcard grant) to read", async () => {
    callerPrincipalId = "prn_admin";
    const res = await buildApp().request("/admin/roles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: { name: string }[] };
    expect(body.roles[0]?.name).toBe("admin");
  });

  it.each([
    ["/admin/principals/prn_x/elevate"],
    ["/admin/principals/prn_x/demote"],
  ])("denies a non-admin with 403 on mutating route %s", async (path) => {
    callerPrincipalId = "prn_member";
    assignRole.mockClear();
    removeRole.mockClear();
    const res = await buildApp().request(path, { method: "POST" });
    expect(res.status).toBe(403);
    expect(assignRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });
});

describe("admin role management", () => {
  it("elevates a principal by assigning the admin role + audits", async () => {
    callerPrincipalId = "prn_admin";
    principalExists = true;
    assignRole.mockClear();
    recordAudit.mockClear();
    const res = await buildApp().request("/admin/principals/prn_x/elevate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(assignRole).toHaveBeenCalledTimes(1);
    expect(assignRole.mock.calls[0]?.[3]).toBe("rol_admin");
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("demotes a principal by removing the admin role + audits", async () => {
    callerPrincipalId = "prn_admin";
    principalExists = true;
    removeRole.mockClear();
    recordAudit.mockClear();
    const res = await buildApp().request("/admin/principals/prn_x/demote", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(removeRole).toHaveBeenCalledTimes(1);
    expect(removeRole.mock.calls[0]?.[2]).toBe("rol_admin");
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("404s on elevate for an unknown principal and writes no role", async () => {
    callerPrincipalId = "prn_admin";
    principalExists = false;
    assignRole.mockClear();
    const res = await buildApp().request(
      "/admin/principals/prn_ghost/elevate",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(404);
    expect(assignRole).not.toHaveBeenCalled();
    principalExists = true;
  });
});

describe("definitions browser pagination + filters", () => {
  function seedDefinitions() {
    listWorkflowDefinitionSummaries.mockResolvedValue([
      {
        kind: "workflow",
        key: "brief-builder",
        name: "Brief Builder",
        version: "1",
        status: "running",
        description: null,
        deploymentCount: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    listAgentDefinitionSummaries.mockResolvedValue([
      {
        kind: "agent",
        key: "agt_a",
        name: "Myra",
        version: "2",
        status: "deployed",
        description: null,
        deploymentCount: 1,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        kind: "agent",
        key: "agt_b",
        name: "Oat",
        version: "1",
        status: "deployed",
        description: null,
        deploymentCount: 1,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
  }

  it("returns the requested page/limit with correct pageInfo", async () => {
    callerPrincipalId = "prn_admin";
    seedDefinitions();
    const res = await buildApp().request("/admin/definitions?page=1&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      definitions: { key: string }[];
      pageInfo: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    };
    // 3 total definitions across workflow+agent, page size 2 → 2 rows, 2 pages.
    expect(body.definitions).toHaveLength(2);
    expect(body.pageInfo).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it("second page returns the remaining row", async () => {
    callerPrincipalId = "prn_admin";
    seedDefinitions();
    const res = await buildApp().request("/admin/definitions?page=2&limit=2");
    const body = (await res.json()) as { definitions: unknown[] };
    expect(body.definitions).toHaveLength(1);
  });

  it("kind filter narrows to a single kind", async () => {
    callerPrincipalId = "prn_admin";
    seedDefinitions();
    const res = await buildApp().request("/admin/definitions?kind=agent");
    const body = (await res.json()) as {
      definitions: { kind: string }[];
      pageInfo: { total: number };
    };
    expect(body.pageInfo.total).toBe(2);
    expect(body.definitions.every((d) => d.kind === "agent")).toBe(true);
  });

  it("search filter narrows by name", async () => {
    callerPrincipalId = "prn_admin";
    seedDefinitions();
    const res = await buildApp().request("/admin/definitions?search=brief");
    const body = (await res.json()) as { definitions: { key: string }[] };
    expect(body.definitions).toHaveLength(1);
    expect(body.definitions[0]?.key).toBe("brief-builder");
  });
});
