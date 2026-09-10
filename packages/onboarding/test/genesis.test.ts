import { describe, expect, test } from "bun:test";
import type { ApiCall } from "@corbits/hub-api-client";
import type { AccessPolicyStore } from "@workbench/access-policy";
import {
  genesisOrJoinHubSignup,
  ProvisionError,
  type GenesisOrJoinArgs,
  type HubSignupTenancy,
} from "../src/genesis";

const TENANT_ID = "ten_root";
const TENANT_SLUG = "workbench";
const PRINCIPAL_ID = "prn_owner";
const MEMBER_PRINCIPAL_ID = "prn_member";

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function throwingAccessPolicy(): NonNullable<
  GenesisOrJoinArgs["accessPolicy"]
> {
  const store = {
    getPolicy: async () => {
      throw new Error("checkSignupGate must not run for genesis or join");
    },
  } as unknown as AccessPolicyStore;
  return {
    store,
    envSignupMode: "closed",
    envAllowedDomains: [],
    allowUnverifiedEmails: false,
  };
}

function tenancy(state: {
  users?: number;
  tenants?: number;
  root?: { id: string; slug: string } | null;
  joins?: { tenantId: string; userId: string; roleName: string }[];
}): HubSignupTenancy {
  const joins = state.joins ?? [];
  return {
    countUsers: async () => state.users ?? 0,
    countTenants: async () => state.tenants ?? 0,
    findRootTenant: async () => (state.root === undefined ? null : state.root),
    addActiveMember: async (args) => {
      joins.push(args);
      return { principalId: MEMBER_PRINCIPAL_ID };
    },
  };
}

function principalsResponse(
  rows: {
    principalId: string;
    tenantId: string;
    tenantSlug: string;
  }[],
) {
  return {
    status: 200,
    data: {
      data: rows.map((row) => ({
        principalId: row.principalId,
        tenantId: row.tenantId,
        tenantName: "Workbench",
        tenantSlug: row.tenantSlug,
        kind: "user",
        status: "active",
        roles: [],
      })),
      nextCursor: null,
    },
    cookies: [],
  };
}

function argsFor(partial: {
  api: ApiCall;
  tenancy: HubSignupTenancy;
  displayName?: string;
  log?: (line: string) => void;
}): GenesisOrJoinArgs {
  const args: GenesisOrJoinArgs = {
    api: partial.api,
    cookies: ["session=abc"],
    userId: "user_1",
    userEmail: "alice@example.com",
    userEmailVerified: true,
    defaultTenantSlug: TENANT_SLUG,
    tenancy: partial.tenancy,
    accessPolicy: throwingAccessPolicy(),
    log: partial.log ?? collector().log,
  };
  if (partial.displayName !== undefined) args.displayName = partial.displayName;
  return args;
}

describe("genesisOrJoinHubSignup", () => {
  test("nonempty principals is existing-member: no tenant create, no join, no seed", async () => {
    const joins: { tenantId: string; userId: string; roleName: string }[] = [];
    let tenantCreates = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([
          {
            principalId: PRINCIPAL_ID,
            tenantId: TENANT_ID,
            tenantSlug: TENANT_SLUG,
          },
        ]);
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreates += 1;
        throw new Error("must not mint a tenant for an existing member");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({
          users: 1,
          tenants: 1,
          root: { id: TENANT_ID, slug: TENANT_SLUG },
          joins,
        }),
        displayName: "Acme",
      }),
    );

    expect(result).toEqual({ kind: "existing-member" });
    expect(tenantCreates).toBe(0);
    expect(joins).toEqual([]);
  });

  test("an existing tenant joins the caller as member and never POSTs /api/tenants", async () => {
    const joins: { tenantId: string; userId: string; roleName: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      if (method === "POST" && path === "/api/tenants") {
        throw new Error("join must never mint a tenant");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({
          users: 2,
          tenants: 1,
          root: { id: TENANT_ID, slug: TENANT_SLUG },
          joins,
        }),
        displayName: "Bob",
      }),
    );

    expect(result).toEqual({
      kind: "joined",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: MEMBER_PRINCIPAL_ID,
    });
    expect(joins).toEqual([
      { tenantId: TENANT_ID, userId: "user_1", roleName: "member" },
    ]);
  });

  test("countUsers > 1 with zero tenants still joins the root rather than minting", async () => {
    const joins: { tenantId: string; userId: string; roleName: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      if (method === "POST" && path === "/api/tenants") {
        throw new Error("must not mint when another user already exists");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({
          users: 2,
          tenants: 0,
          root: { id: TENANT_ID, slug: TENANT_SLUG },
          joins,
        }),
        displayName: "Bob",
      }),
    );

    expect(result.kind).toBe("joined");
    expect(joins).toHaveLength(1);
  });

  test("zero tenants and no display name returns needs-onboarding and creates nothing", async () => {
    let tenantCreates = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreates += 1;
        throw new Error("must not create without a display name");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({ users: 1, tenants: 0, root: null }),
      }),
    );

    expect(result).toEqual({ kind: "needs-onboarding" });
    expect(tenantCreates).toBe(0);
  });

  test("blank display name is needs-onboarding", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({ users: 1, tenants: 0, root: null }),
        displayName: "   ",
      }),
    );

    expect(result).toEqual({ kind: "needs-onboarding" });
  });

  test("empty hub genesis POSTs /api/tenants with name and default slug and no parentId", async () => {
    let principalsCalls = 0;
    const bodies: unknown[] = [];
    const api: ApiCall = async (method, path, body) => {
      if (path.includes("/assets") || path.includes("/workflows")) {
        throw new Error(`signup must not seed: ${method} ${path}`);
      }
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) return principalsResponse([]);
        return principalsResponse([
          {
            principalId: PRINCIPAL_ID,
            tenantId: TENANT_ID,
            tenantSlug: TENANT_SLUG,
          },
        ]);
      }
      if (method === "POST" && path === "/api/tenants") {
        bodies.push(body);
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "Acme",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({ users: 1, tenants: 0, root: null }),
        displayName: "Acme",
      }),
    );

    expect(result).toEqual({
      kind: "genesis",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
    });
    expect(bodies).toEqual([{ name: "Acme", slug: TENANT_SLUG }]);
  });

  test("genesis 409 when a root exists joins as member", async () => {
    const joins: { tenantId: string; userId: string; roleName: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({
          users: 1,
          tenants: 0,
          root: { id: TENANT_ID, slug: TENANT_SLUG },
          joins,
        }),
        displayName: "Acme",
      }),
    );

    expect(result).toEqual({
      kind: "joined",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: MEMBER_PRINCIPAL_ID,
    });
    expect(joins).toHaveLength(1);
  });

  test("genesis 409 with no root and no principal is slug_conflict_no_principal", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await expect(
      genesisOrJoinHubSignup(
        argsFor({
          api,
          tenancy: tenancy({ users: 1, tenants: 0, root: null }),
          displayName: "Acme",
        }),
      ),
    ).rejects.toMatchObject({
      name: "ProvisionError",
      code: "slug_conflict_no_principal",
    });
  });

  test("closed accessPolicy is never consulted for genesis or join", async () => {
    let principalsCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) return principalsResponse([]);
        return principalsResponse([
          {
            principalId: PRINCIPAL_ID,
            tenantId: TENANT_ID,
            tenantSlug: TENANT_SLUG,
          },
        ]);
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "Acme",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await genesisOrJoinHubSignup(
      argsFor({
        api,
        tenancy: tenancy({ users: 1, tenants: 0, root: null }),
        displayName: "Acme",
      }),
    );
  });
});

test("ProvisionError is constructible for route mapping", () => {
  const error = new ProvisionError("tenant_create_failed", "nope", "transient");
  expect(error.errorKind).toBe("transient");
});
