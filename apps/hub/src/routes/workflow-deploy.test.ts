import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as intxDb from "@intx/db";
import type { GrantRule } from "@intx/authz";

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

const ensureGlobalMember = mock(async () => ({
  tenantId: "tenant_global",
  principalId: "caller_principal",
}));
mock.module("../lib/tenant-provisioning", () => ({ ensureGlobalMember }));

const getRequestedUserContext = mock(
  async (): Promise<{
    context: { tenantId: string; principalId: string } | null;
    forbidden: boolean;
  }> => ({
    context: { tenantId: "tenant_global", principalId: "caller_principal" },
    forbidden: false,
  }),
);
mock.module("../lib/user-context", () => ({ getRequestedUserContext }));

const {
  createWorkflowDeployRouter,
  createWorkflowDeployGrantGuard,
  deleteWorkflowHandler,
} = await import("./workflow-deploy");
const { Hono } = await import("hono");

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

type InsertedRow = {
  tenantId: string;
  deploymentId: string;
  kind: string;
  meta?: unknown;
};

function makeDeps(opts: {
  tenantsBySlug: Record<string, { id: string } | undefined>;
  ownerByTenant: Record<string, { id: string } | undefined>;
  inserted: InsertedRow[];
  // Prior active runs of the deploying kind/tenant the supersede sweep finds.
  // Defaults to none, so the deploy-path tests exercise the no-prior case.
  priorRuns?: { id: string; deploymentId: string }[];
  endedSessions?: string[];
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
      workflowRun: {
        findMany: async () => opts.priorRuns ?? [],
      },
      agentInstance: {
        findMany: async () => [],
      },
    },
    insert: () => ({
      values: async (row: InsertedRow) => {
        opts.inserted.push(row);
      },
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
  } as unknown as Parameters<typeof createWorkflowDeployRouter>[0]["db"];

  const workflowDeployService = {
    deployWorkflow: async () => ({ kind: "trivial" as const }),
  } as unknown as Parameters<
    typeof createWorkflowDeployRouter
  >[0]["workflowDeployService"];

  const sessionService = {
    endSession: async (address: string) => {
      opts.endedSessions?.push(address);
    },
  } as unknown as Parameters<
    typeof createWorkflowDeployRouter
  >[0]["sessionService"];

  return {
    db,
    workflowDeployService,
    sessionService,
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

describe("createWorkflowDeployGrantGuard", () => {
  function grantRule(resource: string, action: string): GrantRule {
    return {
      id: "g1",
      resource,
      action,
      effect: "allow",
      origin: "role",
      conditions: null,
      expiresAt: null,
      roleId: "role_owner",
      principalId: null,
    };
  }

  function appWithGrants(grants: GrantRule[]) {
    const grantStore = { collectGrants: async () => grants };
    const guard = createWorkflowDeployGrantGuard({
      db: {} as Parameters<typeof createWorkflowDeployGrantGuard>[0]["db"],
      grantStore,
      globalTenantId: GLOBAL,
    });
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "user1");
      await next();
    });
    app.post("/workflows/deploy", guard, (c) => c.json({ ok: true }));
    return app;
  }

  function post(app: ReturnType<typeof appWithGrants>): Promise<Response> {
    return Promise.resolve(
      app.request("/workflows/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  }

  test("allows a caller whose owner role grants *:*", async () => {
    const res = await post(appWithGrants([grantRule("*", "*")]));
    expect(res.status).toBe(200);
  });

  test("allows a caller granted workflow:* / create", async () => {
    const res = await post(appWithGrants([grantRule("workflow:*", "create")]));
    expect(res.status).toBe(200);
  });

  test("denies (403) a caller with no matching grant", async () => {
    const res = await post(appWithGrants([grantRule("agent:*", "read")]));
    expect(res.status).toBe(403);
  });

  test("denies (403) a caller with no grants at all", async () => {
    const res = await post(appWithGrants([]));
    expect(res.status).toBe(403);
  });
});

// Records every DB mutation + sidecar teardown so the DELETE / supersede tests
// assert behavior (what got soft-deleted, stopped, and undeployed) rather than
// the mock. One `agent_instance` row per address the teardown sweep returns.
type TeardownRecorder = {
  ownedRun: { id: string; tenantId: string } | null;
  priorRuns: { id: string; deploymentId: string }[];
  instances: { id: string; address: string }[];
  runUpdates: { set: { deletedAt?: Date; status?: string } }[];
  stoppedInstances: number;
  endedSessions: string[];
  endSessionThrows?: boolean;
};

function makeTeardownDeps(rec: TeardownRecorder) {
  const db = {
    query: {
      workflowRun: {
        findFirst: async () => rec.ownedRun ?? undefined,
        findMany: async () => rec.priorRuns,
      },
      agentInstance: {
        findMany: async () => rec.instances,
      },
    },
    update: () => ({
      set: (set: { deletedAt?: Date; status?: string; endedAt?: Date }) => ({
        where: async () => {
          if (set.endedAt !== undefined) {
            rec.stoppedInstances += 1;
            return;
          }
          rec.runUpdates.push({ set });
        },
      }),
    }),
  } as unknown as Parameters<typeof deleteWorkflowHandler>[0]["db"];

  const sessionService = {
    endSession: async (address: string) => {
      if (rec.endSessionThrows) throw new Error("sidecar unreachable");
      rec.endedSessions.push(address);
    },
  } as unknown as Parameters<typeof deleteWorkflowHandler>[0]["sessionService"];

  return { db, sessionService, deploymentDomain: "local" };
}

function deleteApp(rec: TeardownRecorder) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user1");
    await next();
  });
  app.delete(
    "/workflows/:deploymentId",
    deleteWorkflowHandler(makeTeardownDeps(rec)),
  );
  return app;
}

function del(
  app: ReturnType<typeof deleteApp>,
  deploymentId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/workflows/${deploymentId}`, { method: "DELETE" }),
  );
}

function emptyRecorder(over: Partial<TeardownRecorder> = {}): TeardownRecorder {
  return {
    ownedRun: null,
    priorRuns: [],
    instances: [],
    runUpdates: [],
    stoppedInstances: 0,
    endedSessions: [],
    ...over,
  };
}

describe("deleteWorkflowHandler", () => {
  beforeEach(() => {
    ancestorChain = ["tenant_global"];
    getRequestedUserContext.mockResolvedValue({
      context: { tenantId: "tenant_global", principalId: "caller_principal" },
      forbidden: false,
    });
  });

  test("404 for an unknown or already-deleted deployment, no teardown", async () => {
    const rec = emptyRecorder({ ownedRun: null });
    const res = await del(deleteApp(rec), "ses_ghost");
    expect(res.status).toBe(404);
    expect(rec.runUpdates).toHaveLength(0);
    expect(rec.endedSessions).toHaveLength(0);
  });

  test("404 when the caller's tenant cannot see the deployment", async () => {
    // getRequestedUserContext resolves a context, but the tenant-scoped
    // lookup returns null (the row lives outside the caller's chain).
    const rec = emptyRecorder({ ownedRun: null });
    const res = await del(deleteApp(rec), "ses_other_tenant");
    expect(res.status).toBe(404);
  });

  test("403 when the requested tenant is forbidden", async () => {
    getRequestedUserContext.mockResolvedValueOnce({
      context: null,
      forbidden: true,
    });
    const rec = emptyRecorder();
    const res = await del(deleteApp(rec), "ses_x");
    expect(res.status).toBe(403);
    expect(rec.runUpdates).toHaveLength(0);
  });

  test("soft-deletes the run and tears down supervisor + step instances", async () => {
    const rec = emptyRecorder({
      ownedRun: { id: "row1", tenantId: "tenant_global" },
      instances: [
        { id: "ins_ses_1", address: "ins_ses_1@local" },
        { id: "ins_ses_1-step_a", address: "ins_ses_1-step_a@local" },
      ],
    });
    const res = await del(deleteApp(rec), "ses_1");
    expect(res.status).toBe(204);

    // workflow_run row marked deleted.
    expect(rec.runUpdates).toHaveLength(1);
    expect(rec.runUpdates[0]?.set.deletedAt).toBeInstanceOf(Date);
    expect(rec.runUpdates[0]?.set.status).toBe("deleted");

    // Supervisor address is always undeployed; step addresses too.
    expect(rec.endedSessions).toContain("ins_ses_1@local");
    expect(rec.endedSessions).toContain("ins_ses_1-step_a@local");

    // Step + supervisor instance rows soft-stopped in one update.
    expect(rec.stoppedInstances).toBe(1);
  });

  test("teardown failure still returns 204 (row already soft-deleted)", async () => {
    const rec = emptyRecorder({
      ownedRun: { id: "row1", tenantId: "tenant_global" },
      instances: [{ id: "ins_ses_1", address: "ins_ses_1@local" }],
      endSessionThrows: true,
    });
    const res = await del(deleteApp(rec), "ses_1");
    expect(res.status).toBe(204);
    expect(rec.runUpdates).toHaveLength(1);
  });
});

describe("deployWorkflowHandler meta storage", () => {
  beforeEach(() => {
    lastPrincipalTenant = GLOBAL;
    ancestorChain = ["tenant_global"];
  });

  test("stores parsed meta in the workflow_run row when ?meta= is valid", async () => {
    const inserted: InsertedRow[] = [];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: {},
        ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
        inserted,
      }),
    );
    const meta = {
      version: "1.2.3",
      sha: "abc1234",
      deployedAt: "2026-01-01T00:00:00.000Z",
    };
    const query = `?meta=${encodeURIComponent(JSON.stringify(meta))}`;
    const res = await post(router, query);
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.meta).toEqual(meta);
  });

  test("omits meta on the inserted row when ?meta= is absent", async () => {
    const inserted: InsertedRow[] = [];
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
    expect(inserted[0]?.meta).toBeUndefined();
  });

  test("ignores a malformed (non-JSON) ?meta= and still deploys successfully", async () => {
    const inserted: InsertedRow[] = [];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: {},
        ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
        inserted,
      }),
    );
    const res = await post(router, "?meta=not-valid-json");
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.meta).toBeUndefined();
  });

  test("rejects a ?meta= that is valid JSON but the wrong shape (arktype boundary)", async () => {
    const inserted: InsertedRow[] = [];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: {},
        ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
        inserted,
      }),
    );
    // Missing `sha` + `deployedAt`: well-formed JSON, but not a WorkflowMeta.
    const query = `?meta=${encodeURIComponent(JSON.stringify({ version: "1.0.0" }))}`;
    const res = await post(router, query);
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.meta).toBeUndefined();
  });
});

describe("redeploy supersedes prior deployments", () => {
  beforeEach(() => {
    lastPrincipalTenant = GLOBAL;
    ancestorChain = ["tenant_global"];
  });

  test("a prior active deployment of the same kind is superseded + torn down", async () => {
    const inserted: InsertedRow[] = [];
    const endedSessions: string[] = [];
    const router = createWorkflowDeployRouter(
      makeDeps({
        tenantsBySlug: {},
        ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
        inserted,
        priorRuns: [{ id: "old_row", deploymentId: "ses_old" }],
        endedSessions,
      }),
    );

    const res = await post(router, "");
    expect(res.status).toBe(200);
    // The new deploy's workflow_run row is written.
    expect(inserted).toHaveLength(1);
    // The prior deployment's supervisor address is undeployed.
    expect(endedSessions).toContain("ins_ses_old@local");
  });

  test("a supersede teardown failure does not fail the new deploy", async () => {
    const inserted: InsertedRow[] = [];
    const deps = makeDeps({
      tenantsBySlug: {},
      ownerByTenant: { [GLOBAL]: { id: "owner_global" } },
      inserted,
      priorRuns: [{ id: "old_row", deploymentId: "ses_old" }],
    });
    // Force the prior-deployment teardown to throw.
    deps.sessionService = {
      endSession: async () => {
        throw new Error("sidecar unreachable");
      },
    } as unknown as typeof deps.sessionService;

    const router = createWorkflowDeployRouter(deps);
    const res = await post(router, "");
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });
});
