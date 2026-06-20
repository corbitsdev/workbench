import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as intxDb from "@intx/db";

// Control the global-or-descendant validation deterministically.
let ancestorChain: string[] = [];
const getAncestorChain = mock(async () => ancestorChain);
mock.module("@intx/db", () => ({ ...intxDb, getAncestorChain }));

const resolveWorkflowDeployConfig = mock(async () => ({
  deploymentId: "dep1",
  config: {},
  deployContent: {},
}));
mock.module("../services/workflow-deploy-config", () => ({
  resolveWorkflowDeployConfig,
}));

const { createWorkflowDeployRouter } = await import("./workflow-deploy");

afterAll(() => {
  mock.restore();
});

const GLOBAL = "tenant_global";
const SERVICE_TOKEN = "svc-token";

const validDefinition = {
  id: "call-to-collateral",
  triggers: [],
  steps: {},
  stepOrder: [],
};

type InsertedRow = { tenantId: string; deploymentId: string; kind: string };

function makeDeps(opts: {
  tenantsBySlug: Record<string, { id: string } | undefined>;
  ownerByTenant: Record<string, { id: string } | undefined>;
  inserted: InsertedRow[];
}) {
  const db = {
    query: {
      tenant: {
        findFirst: async () =>
          lastTenantLookup ? opts.tenantsBySlug[lastTenantLookup] : undefined,
      },
      principal: {
        findFirst: async () => opts.ownerByTenant[lastPrincipalTenant ?? ""],
      },
    },
    insert: () => ({
      values: async (row: InsertedRow) => {
        opts.inserted.push(row);
      },
    }),
  } as unknown as Parameters<typeof createWorkflowDeployRouter>[0]["db"];

  const workflowDeployService = {
    deployWorkflow: async () => ({ kind: "trivial" as const }),
  } as unknown as Parameters<
    typeof createWorkflowDeployRouter
  >[0]["workflowDeployService"];

  return {
    db,
    workflowDeployService,
    hubPublicKey: "pk",
    deploymentDomain: "local",
    globalTenantId: GLOBAL,
    serviceToken: SERVICE_TOKEN,
  };
}

// The route resolves tenant-by-slug and principal-by-tenant through drizzle's
// opaque `eq`. The test stub can't read those predicates, so the route is
// driven one slug at a time and these capture the in-flight lookup keys.
let lastTenantLookup: string | undefined;
let lastPrincipalTenant: string | undefined;

beforeEach(() => {
  lastTenantLookup = undefined;
  lastPrincipalTenant = undefined;
});

function post(
  router: ReturnType<typeof createWorkflowDeployRouter>,
  query: string,
  body: unknown = validDefinition,
  token = SERVICE_TOKEN,
): Promise<Response> {
  return Promise.resolve(
    router.request(`/workflows/deploy${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("createWorkflowDeployRouter target tenant", () => {
  test("no target tenant → writes workflow_run on the global tenant", async () => {
    const inserted: InsertedRow[] = [];
    lastPrincipalTenant = GLOBAL;
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: {},
        ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
        inserted,
      }),
    );

    const res = await post(router, "");
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.tenantId).toBe(GLOBAL);
  });

  test("descendant target tenant → writes workflow_run on that tenant", async () => {
    const inserted: InsertedRow[] = [];
    lastTenantLookup = "gtm";
    lastPrincipalTenant = "tenant_gtm";
    ancestorChain = ["tenant_gtm", GLOBAL];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: { gtm: { id: "tenant_gtm" } },
        ownerByTenant: { tenant_gtm: { id: "owner_gtm" } },
        inserted,
      }),
    );

    const res = await post(router, "?tenant=gtm");
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.tenantId).toBe("tenant_gtm");
  });

  test("target tenant outside the global subtree → 403, no write", async () => {
    const inserted: InsertedRow[] = [];
    lastTenantLookup = "other";
    ancestorChain = ["tenant_other", "tenant_unrelated_root"];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: { other: { id: "tenant_other" } },
        ownerByTenant: {},
        inserted,
      }),
    );

    const res = await post(router, "?tenant=other");
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  test("unknown target tenant slug → 404", async () => {
    const inserted: InsertedRow[] = [];
    lastTenantLookup = "ghost";
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: { ghost: undefined },
        ownerByTenant: {},
        inserted,
      }),
    );

    const res = await post(router, "?tenant=ghost");
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  test("rejects a request without the service token", async () => {
    const inserted: InsertedRow[] = [];
    const router = createWorkflowDeployRouter(
      makeDeps({ tenantsBySlug: {}, ownerByTenant: {}, inserted }),
    );
    const res = await post(router, "", validDefinition, "wrong");
    expect(res.status).toBe(401);
  });
});
