import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKFLOWS } from "@corbits/seeding";
import type { ApiCall } from "@corbits/hub-api-client";
import type { HubSignupTenancy } from "../src/genesis";
import {
  isFullySeeded,
  personalTenantSlug,
  provisionPersonalTenantIfNeeded,
} from "../src/provision";

const TENANT_ID = "ten_new";
const PRINCIPAL_ID = "prn_new";
const MEMBER_PRINCIPAL_ID = "prn_member";
const TENANT_SLUG = "workbench";

const TOOLS_ASSET_ID = "ast_corbits_tools";
const SEEDED_MEMORY_TARBALL = {
  filename: "corbits-memory-tools-0.0.4.tgz",
  size: 12,
  integrity: "sha512-seeded",
};

function corbitsToolsAssetRow(tenantId: string) {
  return {
    id: TOOLS_ASSET_ID,
    tenantId,
    kind: "package-registry",
    name: "corbits-tools",
    displayName: null,
    creatorPrincipalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: { tenantId, direct: true },
  };
}

function corbitsToolsRegistryResponse(
  method: string,
  path: string,
  tenantId: string,
  tarballs:
    | readonly { filename: string; size: number; integrity: string }[]
    | "missing",
): { status: number; data: unknown; cookies: string[] } | undefined {
  const inheritedList = `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=true`;
  const localList = `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`;
  if (method === "GET" && (path === inheritedList || path === localList)) {
    if (tarballs === "missing") {
      return { status: 200, data: [], cookies: [] };
    }
    return {
      status: 200,
      data: [corbitsToolsAssetRow(tenantId)],
      cookies: [],
    };
  }
  if (
    method === "GET" &&
    path === `/api/tenants/${tenantId}/assets/${TOOLS_ASSET_ID}/tarballs`
  ) {
    if (tarballs === "missing") {
      return { status: 200, data: [], cookies: [] };
    }
    return { status: 200, data: [...tarballs], cookies: [] };
  }
  return undefined;
}

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
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
}): Parameters<typeof provisionPersonalTenantIfNeeded>[0] {
  const args: Parameters<typeof provisionPersonalTenantIfNeeded>[0] = {
    api: partial.api,
    cookies: ["session=abc"],
    userId: "user_1",
    userEmail: "alice@example.com",
    userEmailVerified: true,
    defaultTenantSlug: TENANT_SLUG,
    tenancy: partial.tenancy,
    log: collector().log,
  };
  if (partial.displayName !== undefined) args.displayName = partial.displayName;
  return args;
}

describe("personalTenantSlug", () => {
  test("derives a lowercase-kebab slug from the email and a user-id fragment", () => {
    expect(personalTenantSlug("Alice.Smith@example.com", "user_id_1")).toBe(
      "alice-smith-userid1",
    );
  });

  test("never produces an empty component", () => {
    expect(personalTenantSlug("@example.com", "")).toBe("bench-personal");
  });
});

describe("provisionPersonalTenantIfNeeded", () => {
  test("an existing member is left alone: no tenant is created", async () => {
    let tenantCreateCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([
          {
            principalId: PRINCIPAL_ID,
            tenantId: "ten_existing",
            tenantSlug: "existing",
          },
        ]);
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreateCalls += 1;
        throw new Error("unexpected tenant creation for an existing member");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded(
      argsFor({
        api,
        tenancy: tenancy({ users: 2, tenants: 1 }),
      }),
    );

    expect(result).toEqual({ kind: "existing-member" });
    expect(tenantCreateCalls).toBe(0);
  });

  test("zero principals without a display name: needs-onboarding, nothing created", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse([]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded(
      argsFor({ api, tenancy: tenancy({ users: 1, tenants: 0 }) }),
    );

    expect(result).toEqual({ kind: "needs-onboarding" });
  });

  test("genesis on an empty hub: provisions the root tenant, seeds nothing", async () => {
    const bodies: unknown[] = [];
    const { lines, log } = collector();
    let principalsCalls = 0;
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
            name: "Alice's Lab",
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

    const result = await provisionPersonalTenantIfNeeded({
      ...argsFor({ api, tenancy: tenancy({ users: 1, tenants: 0 }) }),
      displayName: "Alice's Lab",
      log,
    });

    expect(result).toEqual({
      kind: "provisioned",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      seeded: false,
    });
    expect(bodies).toEqual([{ name: "Alice's Lab", slug: TENANT_SLUG }]);
    expect(lines.some((line) => line.includes("genesis"))).toBe(true);
  });

  test("an occupied hub: the caller joins the root as member, never mints", async () => {
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

    const result = await provisionPersonalTenantIfNeeded(
      argsFor({
        api,
        tenancy: tenancy({
          users: 2,
          tenants: 1,
          root: { id: TENANT_ID, slug: TENANT_SLUG },
          joins,
        }),
      }),
    );

    expect(joins).toEqual([
      { tenantId: TENANT_ID, userId: "user_1", roleName: "member" },
    ]);
    expect(result).toEqual({
      kind: "existing-member",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
    });
  });

  test("a slug conflict that still leaves the caller benchless is a real failure", async () => {
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
      provisionPersonalTenantIfNeeded(
        argsFor({
          api,
          tenancy: tenancy({ users: 1, tenants: 0 }),
          displayName: "Alice's Lab",
        }),
      ),
    ).rejects.toThrow(/slug conflict/);
  });
});

describe("isFullySeeded", () => {
  test("isFullySeeded is false when corbits-tools exists but has no tarballs", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        [],
      );
      if (registry !== undefined) return registry;
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(await isFullySeeded(api, ["session=abc"], TENANT_ID)).toBe(false);
  });

  test("isFullySeeded is true when workflows are live and corbits-tools carries memory-tools", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(method, path, TENANT_ID, [
        SEEDED_MEMORY_TARBALL,
      ]);
      if (registry !== undefined) return registry;
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(await isFullySeeded(api, ["session=abc"], TENANT_ID)).toBe(true);
  });
});
