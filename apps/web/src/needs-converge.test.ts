// The convergence driver diffs the client's needs-list against stock-hub
// reads and executes the minimal stock-API sequence to converge. Every
// test here runs against doubles — never a live hub.

import { describe, expect, test } from "bun:test";

import { buildNeedsList, type NeedsList } from "./needs-list";
import {
  convergeNeedsList,
  createFetchStockHub,
  diffNeedsList,
  readHubSnapshot,
  type HubSnapshot,
  type StockHub,
} from "./needs-converge";

const manifest: NeedsList = buildNeedsList({
  user: { id: "usr_1", email: "ada@example.com" },
  primaryTenant: { slug: "ada", name: "Ada" },
  myraDefinitionRefId: "assistant",
  workbenches: [
    {
      slug: "ada-atlas",
      name: "Atlas",
      members: [{ refId: "usr_2", email: "bea@example.com", role: "member" }],
    },
  ],
  shares: [{ workbenchSlug: "ada-atlas", email: "cyd@example.com" }],
  createdWorkbenchTenantIds: [],
});

function emptySnapshot(): HubSnapshot {
  return { myPrincipals: [], tenantsById: {}, principalsByTenant: {} };
}

function convergedSnapshot(): HubSnapshot {
  return {
    myPrincipals: [
      {
        principalId: "prn_1",
        tenantId: "tnt_primary",
        tenantName: "Ada",
        tenantSlug: "ada",
        kind: "user",
        status: "active",
        roles: [{ id: "r1", name: "owner" }],
      },
      {
        principalId: "prn_2",
        tenantId: "tnt_atlas",
        tenantName: "Atlas",
        tenantSlug: "ada-atlas",
        kind: "user",
        status: "active",
        roles: [{ id: "r1", name: "owner" }],
      },
    ],
    tenantsById: {
      tnt_primary: {
        id: "tnt_primary",
        name: "Ada",
        slug: "ada",
        parentId: null,
      },
      tnt_atlas: {
        id: "tnt_atlas",
        name: "Atlas",
        slug: "ada-atlas",
        parentId: "tnt_primary",
      },
    },
    principalsByTenant: {
      tnt_primary: [
        {
          id: "prn_1",
          tenantId: "tnt_primary",
          kind: "user",
          refId: "usr_1",
          status: "active",
          roles: ["owner"],
        },
        {
          id: "prn_myra",
          tenantId: "tnt_primary",
          kind: "workflow",
          refId: "assistant",
          status: "active",
          roles: [],
        },
      ],
      tnt_atlas: [
        {
          id: "prn_3",
          tenantId: "tnt_atlas",
          kind: "user",
          refId: "usr_1",
          status: "active",
          roles: ["owner"],
        },
        {
          id: "prn_4",
          tenantId: "tnt_atlas",
          kind: "user",
          refId: "usr_2",
          email: "bea@example.com",
          status: "active",
          roles: ["member"],
        },
        {
          id: "prn_5",
          tenantId: "tnt_atlas",
          kind: "user",
          refId: "usr_3",
          email: "cyd@example.com",
          status: "active",
          roles: ["member"],
        },
      ],
    },
  };
}

function recordingHub(snapshot: HubSnapshot) {
  const calls: string[] = [];
  const hub: StockHub = {
    listMyPrincipals: () => {
      calls.push("listMyPrincipals");
      return Promise.resolve(snapshot.myPrincipals);
    },
    getTenant: (id) => {
      calls.push(`getTenant:${id}`);
      return Promise.resolve(snapshot.tenantsById[id] ?? null);
    },
    listPrincipals: (tenantId) => {
      calls.push(`listPrincipals:${tenantId}`);
      return Promise.resolve(snapshot.principalsByTenant[tenantId] ?? []);
    },
    createTenant: (input) => {
      calls.push(`createTenant:${input.slug}`);
      return Promise.resolve({
        id: `tnt_${input.slug}`,
        name: input.name,
        slug: input.slug,
        parentId: input.parentId ?? null,
      });
    },
    inviteMember: (tenantId, input) => {
      calls.push(`inviteMember:${tenantId}:${input.email}`);
      return Promise.resolve();
    },
    deployAgent: (tenantId, input) => {
      calls.push(`deployAgent:${tenantId}:${input.definitionRefId}`);
      return Promise.resolve();
    },
  };
  return { hub, calls };
}

describe("diffNeedsList", () => {
  test("an empty hub needs primary, Myra, and the workbench", () => {
    const ops = diffNeedsList(manifest, emptySnapshot());
    expect(ops.map((op) => op.kind)).toEqual([
      "create-tenant",
      "deploy-agent",
      "create-tenant",
      "invite-member",
      "invite-member",
    ]);
  });

  test("a converged hub needs nothing", () => {
    expect(diffNeedsList(manifest, convergedSnapshot())).toEqual([]);
  });

  test("a missing Myra principal yields one deploy-agent op", () => {
    const snapshot = convergedSnapshot();
    const primary = snapshot.principalsByTenant["tnt_primary"] ?? [];
    snapshot.principalsByTenant["tnt_primary"] = primary.filter(
      (principal) => principal.kind !== "workflow",
    );
    const ops = diffNeedsList(manifest, snapshot);
    expect(ops).toEqual([
      {
        kind: "deploy-agent",
        tenantSlug: "ada",
        definitionRefId: "assistant",
      },
    ]);
  });

  test("a workbench member with the wrong status is re-invited", () => {
    const snapshot = convergedSnapshot();
    const member = snapshot.principalsByTenant["tnt_atlas"]?.find(
      (p) => p.refId === "usr_2",
    );
    if (member !== undefined) member.status = "suspended";
    const ops = diffNeedsList(manifest, snapshot);
    expect(ops.map((op) => op.kind)).toEqual(["invite-member"]);
  });
});

describe("convergeNeedsList", () => {
  test("reads first, then converges an empty hub via stock calls", async () => {
    const { hub, calls } = recordingHub(emptySnapshot());
    const report = await convergeNeedsList(manifest, hub);
    expect(report.applied.map((op) => op.kind)).toEqual([
      "create-tenant",
      "deploy-agent",
      "create-tenant",
      "invite-member",
      "invite-member",
    ]);
    expect(calls[0]).toBe("listMyPrincipals");
    const firstWrite = calls.findIndex((call) =>
      call.startsWith("createTenant"),
    );
    const lastRead = calls.reduce(
      (latest, call, index) =>
        call.startsWith("list") || call.startsWith("getTenant")
          ? index
          : latest,
      -1,
    );
    expect(firstWrite).toBeGreaterThan(lastRead);
  });

  test("a converged hub issues no writes", async () => {
    const { hub, calls } = recordingHub(convergedSnapshot());
    const report = await convergeNeedsList(manifest, hub);
    expect(report.applied).toEqual([]);
    expect(
      calls.some(
        (call) =>
          call.startsWith("createTenant") ||
          call.startsWith("inviteMember") ||
          call.startsWith("deployAgent"),
      ),
    ).toBe(false);
  });

  test("accepts a pre-read snapshot and skips the reads", async () => {
    const { hub, calls } = recordingHub(convergedSnapshot());
    const report = await convergeNeedsList(manifest, hub, convergedSnapshot());
    expect(report.applied).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("readHubSnapshot", () => {
  test("fans out over native tenants/principals reads only", async () => {
    const { hub, calls } = recordingHub(convergedSnapshot());
    const snapshot = await readHubSnapshot(hub, manifest);
    expect(Object.keys(snapshot.tenantsById).sort()).toEqual([
      "tnt_atlas",
      "tnt_primary",
    ]);
    expect(calls).toEqual([
      "listMyPrincipals",
      "getTenant:tnt_primary",
      "listPrincipals:tnt_primary",
      "getTenant:tnt_atlas",
      "listPrincipals:tnt_atlas",
    ]);
  });
});

describe("convergeNeedsList deploy pending", () => {
  test("an unresolvable deploy body is reported pending, never thrown or silently skipped", async () => {
    const { hub, calls } = recordingHub(emptySnapshot());
    const report = await convergeNeedsList(manifest, hub, emptySnapshot(), {
      resolveAgentDeploy: () => undefined,
    });
    // Everything else still converges — only the agent deploy waits for
    // the catalog seed that the credential step brings.
    expect(report.applied.map((op) => op.kind)).toEqual([
      "create-tenant",
      "create-tenant",
      "invite-member",
      "invite-member",
    ]);
    expect(report.pending).toEqual([
      {
        kind: "deploy-agent",
        tenantSlug: "ada",
        definitionRefId: "assistant",
      },
    ]);
    expect(calls.some((call) => call.startsWith("deployAgent"))).toBe(false);
  });

  test("a resolved deploy body still deploys and leaves nothing pending", async () => {
    const { hub, calls } = recordingHub(emptySnapshot());
    const report = await convergeNeedsList(manifest, hub, emptySnapshot(), {
      resolveAgentDeploy: () => ({ definitionAssetId: "ast_1" }),
    });
    expect(report.applied.map((op) => op.kind)).toEqual([
      "create-tenant",
      "deploy-agent",
      "create-tenant",
      "invite-member",
      "invite-member",
    ]);
    expect(report.pending).toEqual([]);
    expect(calls.some((call) => call.startsWith("deployAgent:tnt_ada"))).toBe(
      true,
    );
  });

  test("a workbench member without an email is an explicit skip, not a silent drop", async () => {
    const emailLess: NeedsList = buildNeedsList({
      user: { id: "usr_1", email: "ada@example.com" },
      primaryTenant: { slug: "ada", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          slug: "ada-atlas",
          name: "Atlas",
          members: [{ refId: "usr_9", role: "member" }],
        },
      ],
      shares: [],
      createdWorkbenchTenantIds: [],
    });
    const { hub } = recordingHub(emptySnapshot());
    const report = await convergeNeedsList(emailLess, hub, emptySnapshot(), {
      resolveAgentDeploy: () => ({ definitionAssetId: "ast_1" }),
    });
    expect(report.skipped).toEqual([
      {
        kind: "invite-member",
        tenantSlug: "ada-atlas",
        reason: "member without an email address cannot be invited",
      },
    ]);
  });
});

describe("createFetchStockHub", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  function stubFetch(respond: (path: string, init?: RequestInit) => Response) {
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      calls.push(init === undefined ? { path } : { path, init });
      return Promise.resolve(respond(path, init));
    };
    return { fetchImpl: fetchImpl as typeof fetch, calls };
  }

  test("reads hit the native tenants/principals routes", async () => {
    const { fetchImpl, calls } = stubFetch((path) => {
      if (path === "/api/me/principals") {
        return json({ data: [], nextCursor: null });
      }
      if (path === "/api/tenants/tnt_1") {
        return json({
          id: "tnt_1",
          name: "Ada",
          slug: "ada",
          domain: "ada.localhost",
          parentId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      if (path.startsWith("/api/tenants/tnt_1/principals")) {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const hub = createFetchStockHub(fetchImpl);
    await hub.listMyPrincipals();
    await hub.getTenant("tnt_1");
    await hub.listPrincipals("tnt_1");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/me/principals",
      "/api/tenants/tnt_1",
      "/api/tenants/tnt_1/principals?limit=100",
    ]);
  });

  test("writes use stock tenant, invite, and workflow routes", async () => {
    const { fetchImpl, calls } = stubFetch((path, init) => {
      if (path === "/api/tenants" && init?.method === "POST") {
        return json(
          {
            id: "tnt_new",
            name: "Atlas",
            slug: "ada-atlas",
            domain: "ada-atlas.localhost",
            parentId: "tnt_1",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          201,
        );
      }
      if (path === "/api/tenants/tnt_1/members/invite") {
        return json({}, 201);
      }
      if (path === "/api/tenants/tnt_1/workflows/deployments") {
        return json({}, 201);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const hub = createFetchStockHub(fetchImpl, {
      resolveAgentDeploy: (op) => ({
        source: "test-double",
        definitionRefId: op.definitionRefId,
      }),
    });
    await hub.createTenant({
      name: "Atlas",
      slug: "ada-atlas",
      parentId: "tnt_1",
    });
    await hub.inviteMember("tnt_1", { email: "bea@example.com" });
    await hub.deployAgent("tnt_1", { definitionRefId: "assistant" });
    const posts = calls.filter((call) => call.init?.method === "POST");
    expect(posts.map((call) => call.path)).toEqual([
      "/api/tenants",
      "/api/tenants/tnt_1/members/invite",
      "/api/tenants/tnt_1/workflows/deployments",
    ]);
    for (const call of calls) {
      expect(call.path.startsWith("/api/")).toBe(true);
      expect(call.path).not.toContain("/api/onboarding");
      expect(call.path).not.toContain("/api/workbench-tenancies");
      expect(call.path).not.toContain("/chat/");
    }
  });

  test("membership reads follow cursor pages instead of stopping at the first", async () => {
    const page = (rows: unknown[], nextCursor: string | null) =>
      json({ data: rows, nextCursor });
    const mine = (tenantId: string, tenantSlug: string) => ({
      principalId: `prn_${tenantId}`,
      tenantId,
      tenantName: tenantSlug,
      tenantSlug,
      kind: "user",
      status: "active",
      roles: [{ id: "r1", name: "owner" }],
    });
    const { fetchImpl, calls } = stubFetch((path) => {
      if (path === "/api/me/principals") {
        return page([mine("tnt_1", "ada")], "cursor_2");
      }
      if (path === "/api/me/principals?cursor=cursor_2") {
        return page([mine("tnt_2", "ada-atlas")], null);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const hub = createFetchStockHub(fetchImpl);
    const principals = await hub.listMyPrincipals();
    expect(principals.map((row) => row.tenantId)).toEqual(["tnt_1", "tnt_2"]);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/me/principals",
      "/api/me/principals?cursor=cursor_2",
    ]);
  });

  test("tenant principal reads follow cursor pages", async () => {
    const row = (id: string) => ({
      id,
      tenantId: "tnt_1",
      kind: "user",
      refId: "usr_1",
      status: "active",
      roles: ["owner"],
    });
    const { fetchImpl, calls } = stubFetch((path) => {
      if (path === "/api/tenants/tnt_1/principals?limit=100") {
        return json({ data: [row("prn_1")], nextCursor: "cursor_2" });
      }
      if (path === "/api/tenants/tnt_1/principals?limit=100&cursor=cursor_2") {
        return json({ data: [row("prn_2")], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const hub = createFetchStockHub(fetchImpl);
    const principals = await hub.listPrincipals("tnt_1");
    expect(principals.map((row) => row.id)).toEqual(["prn_1", "prn_2"]);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/tenants/tnt_1/principals?limit=100",
      "/api/tenants/tnt_1/principals?limit=100&cursor=cursor_2",
    ]);
  });

  test("deployAgent hands the resolver the manifest tenant slug, not the tenant id", async () => {
    const seen: { tenantId: string; tenantSlug: string }[] = [];
    const { fetchImpl } = stubFetch((path) => {
      if (path === "/api/tenants/tnt_1/workflows/deployments") {
        return json({}, 201);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const hub = createFetchStockHub(fetchImpl, {
      resolveAgentDeploy: (op) => {
        seen.push({ tenantId: op.tenantId, tenantSlug: op.tenantSlug });
        return { definitionAssetId: "ast_1" };
      },
    });
    await hub.deployAgent("tnt_1", {
      definitionRefId: "assistant",
      tenantSlug: "ada",
    });
    expect(seen).toEqual([{ tenantId: "tnt_1", tenantSlug: "ada" }]);
  });
});
