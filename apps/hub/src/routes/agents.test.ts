import { describe, expect, it, mock } from "bun:test";
import * as intxDbReal from "@intx/db";
import type { DB } from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

const TEST_API_KEY = "sk-test-key";

mock.module("../config", () => ({
  getConfig: () => ({
    globalTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
}));

// Launch outcome is driven by resolveModelSources: tests set `sourcesImpl` to
// return sources (launch proceeds), an empty array (resolution fails with
// no_requirements), or throw (resolution errors). The launch path resolves a
// definition's requirements against the instance tenant via resolveModelSources
// (CL-2229), so the definition may be ancestor-owned.
// CL-1521: sources are now plaintext (stored plaintext in DB, not encrypted).
let sourcesImpl: () => Promise<unknown[]> = () =>
  Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
mock.module("@intx/db", () => ({
  ...intxDbReal,
  resolveModelSources: async () => {
    const sources = await sourcesImpl();
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
}));

import { Hono } from "hono";
import { createAgentProvisioningRouter } from "./agents";
import { memberAgentInstance } from "../db/schema";
import {
  persistInstanceToolGrants,
  persistInstanceGrantRequirements,
  launchAgentSession,
  relaunchInstanceIfNeeded,
  reconcileDisconnectedSession,
  registerDisconnectReconciler,
} from "../services/agent-provisioning";

const { agentInstance: agentInstanceTable } = intxDbReal.schema;

function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {},
): Request {
  const { method = "GET", body, userId = "user-1" } = opts;
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const mockSessionService: SessionService = {
  launchSession: mock(() => Promise.resolve()),
  sendUserMessage: mock(() => Promise.reject(new Error("not implemented"))),
  endSession: mock(() => Promise.reject(new Error("not implemented"))),
} as unknown as SessionService;

const mockGrantStore: GrantStore = {
  collectGrants: mock(() => Promise.resolve([])),
};

const mockSidecarRouter: SidecarRouter = {
  sendSourcesUpdate: mock(() => Promise.resolve()),
  getRoutableAddresses: mock(() => [] as string[]),
  events: { on: () => () => {} },
} as unknown as SidecarRouter;

function makeSidecarRouter(
  routable: string[] = [],
  overrides: Partial<SidecarRouter> = {},
): SidecarRouter {
  return {
    sendSourcesUpdate: mock(() => Promise.resolve()),
    sendGrantsUpdate: mock(() => Promise.resolve()),
    getRoutableAddresses: mock(() => routable),
    events: { on: () => () => {} },
    ...overrides,
  } as unknown as SidecarRouter;
}

const mockEventCollectors = {
  create: mock(() => {}),
  dispatch: mock(() => {}),
  abandon: mock(() => {}),
  has: mock(() => false),
  getStatus: mock(() => undefined),
  getAccumulatedText: mock(() => undefined),
  getCurrentTurnId: mock(() => undefined),
  getLastTurnId: mock(() => undefined),
} as unknown as import("@intx/hub-sessions").EventCollectorRegistry;

function buildApp(
  db: ReturnType<typeof makeMockDb>,
  sessionService: SessionService = mockSessionService,
  userId = "user-1",
  sidecarRouter: SidecarRouter = mockSidecarRouter,
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  parent.route(
    "/",
    createAgentProvisioningRouter(
      db as unknown as DB["db"],
      sessionService,
      mockGrantStore,
      sidecarRouter,
      mockEventCollectors,
    ),
  );
  return parent;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeSelectChain(rows: any[] = []) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const wherePromise = Promise.resolve(rows) as Promise<any[]> & {
    limit?: unknown;
  };
  wherePromise.limit = mock(() => Promise.resolve(rows));
  const chain: any = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => wherePromise),
  };
  return chain;
}

function makeMockDb(overrides: Record<string, unknown> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  let base: any;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
  base = {
    transaction: txMock,
    query: {
      principal: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      tenant: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      agent: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      agentInstance: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      agentSession: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      memberAgentInstance: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      provider: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
      credential: {
        findFirst: mock(() => Promise.resolve(undefined)),
        findMany: mock(() => Promise.resolve([])),
      },
    },
    select: mock(() => makeSelectChain([])),
    insert: mock(() => {
      const onConflictChain = {
        returning: mock(() => Promise.resolve([])),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const valuesChain: any = {
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => onConflictChain),
        onConflictDoUpdate: mock(() => onConflictChain),
      };
      return { values: mock(() => valuesChain) };
    }),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => Promise.resolve()),
    })),
    ...overrides,
  };
  return base;
}

// ─── Shared fixtures ──────────────────────────────────────────────

const TENANT = {
  id: "tenant-1",
  domain: "tenant-1.localhost",
  slug: "ws-1",
  name: "Workbench 1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn-1",
  tenantId: "tenant-1",
  kind: "user",
  refId: "user-1",
};

// ─── GET /agents ──────────────────────────────────────────────────

describe("GET /agents", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(makeRequest("http://localhost/agents"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("tenantId");
  });

  it("returns 403 when the caller has no principal in the queried tenant", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-other"),
    );
    expect(res.status).toBe(403);
  });

  it("returns agent list when the caller has a principal in the tenant", async () => {
    const instance = {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: "ins-1@tenant-1.localhost",
      status: "deployed",
      principalId: "prn-agent-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const agentRow = { id: "agt-1", name: "Loop", tenantId: "tenant-1" };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let base: any;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) => fn(base));
    base = {
      transaction: txMock,
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: {
          findFirst: mock(() => Promise.resolve(agentRow)),
          findMany: mock(() => Promise.resolve([agentRow])),
        },
        agentInstance: {
          findFirst: mock(() => Promise.resolve(undefined)),
          findMany: mock(() => Promise.resolve([instance])),
        },
        memberAgentInstance: {
          findMany: mock(() => Promise.resolve([{ instanceId: "ins-1" }])),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        credential: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: mock(() => ({
        values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
      delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
    };

    const app = buildApp(base);
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].agentName).toBe("Loop");
  });

  it("excludes removed instances (endedAt set) from the list query", async () => {
    // Search a drizzle SQL condition for a column with the given name. Only
    // descends through queryChunks/arrays — never into a Column's `.table`
    // back-reference, which would otherwise surface every column in the schema.
    // biome-ignore lint/suspicious/noExplicitAny: introspecting drizzle SQL chunks
    function referencesColumn(
      node: any,
      columnName: string,
      seen = new Set(),
    ): boolean {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (node.name === columnName && node.columnType) return true;
      const children = Array.isArray(node) ? node : (node.queryChunks ?? []);
      return children.some((child: unknown) =>
        referencesColumn(child, columnName, seen),
      );
    }

    const db = makeMockDb({
      query: {
        principal: { findFirst: mock(() => Promise.resolve(PRINCIPAL)) },
        agent: { findMany: mock(() => Promise.resolve([])) },
        agentInstance: { findMany: mock(() => Promise.resolve([])) },
        // A membership is required for the route to reach the agentInstance
        // query whose where-clause this test inspects.
        memberAgentInstance: {
          findMany: mock(() => Promise.resolve([{ instanceId: "ins-1" }])),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);

    const findManyArgs = db.query.agentInstance.findMany.mock.calls[0][0];
    expect(referencesColumn(findManyArgs.where, "ended_at")).toBe(true);
  });
});

// ─── POST /instances/:instanceId/sessions ────────────────────────

describe("POST /instances/:instanceId/sessions", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "deployed",
    principalId: "prn-agent-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const AGENT_ROW = {
    id: "agt-1",
    name: "Loop",
    tenantId: "tenant-1",
    systemPrompt: "You are Loop.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };

  it("returns 404 when instance not found", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) when caller has no principal in the instance tenant, to avoid leaking instance existence", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with launched:true on successful session start", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
  });

  it("returns 200 with launched:true when the instance is already running (relaunches to recover after sidecar reconnect)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "running" }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
    expect(sessionService.launchSession).toHaveBeenCalled();
  });

  it("returns 200 with launched:true when launchSession fails because the agent already exists on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // In production, the sidecar returns "Agent already exists" wrapped in a
    // provision-phase SessionLaunchError. Simulate that here.
    const provisionError = new SessionLaunchError(
      "provision",
      new Error(`Agent already exists for address "ins-1@tenant-1.localhost"`),
      false,
    );
    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.reject(provisionError)),
    };
    const app = buildApp(db, sessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.launched).toBe(true);
    expect("launchError" in json).toBe(false);
    // Provision-phase failures must not be retried — one attempt only.
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it("returns 503 with error when source resolution yields nothing", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));

    // No resolvable inference sources — launch fails and the endpoint surfaces 503.
    sourcesImpl = () => Promise.resolve([]);

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("No resolvable inference sources");
  });
});

describe("relaunchInstanceIfNeeded", () => {
  const TENANT_ROW = { id: "tenant-1", domain: "tenant-1.localhost" };
  const AGENT_ROW = {
    id: "agt-1",
    systemPrompt: "You are Myra.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };
  const ACTIVE_CREDENTIAL = {
    id: "crd-1",
    tenantId: "tenant-1",
    status: "active",
  };

  function runningInstance(overrides: Record<string, unknown> = {}) {
    return {
      id: "ins-1",
      agentId: "agt-1",
      tenantId: "tenant-1",
      address: "ins-1@tenant-1.localhost",
      status: "running",
      sessionId: "ses-1",
      principalId: "prn-agent-1",
      ...overrides,
    };
  }

  it('handles "agent already exists" gracefully when instance is running on sidecar', async () => {
    // After a sidecar restart the DB may still show "running" while the sidecar has the agent
    // alive. launchSession throws "Agent already exists for address"; relaunchInstanceIfNeeded
    // must treat that as success rather than surfacing an error.
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance()),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      // The sidecar wraps the "already exists" error in a provision-phase SessionLaunchError,
      // which breaks the retry loop and propagates to our isAgentAlreadyExistsError check.
      launchSession: mock(() =>
        Promise.reject(
          new SessionLaunchError(
            "provision",
            new Error(
              "Agent already exists for address ins-1@tenant-1.localhost",
            ),
            false,
          ),
        ),
      ),
    };
    // Must not throw — the agent is live, so this is a no-op.
    await expect(
      relaunchInstanceIfNeeded(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        "ins-1",
        makeSidecarRouter() as never,
      ),
    ).resolves.toBeUndefined();

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch a deployed instance that still has an active session (harness owns continuity) (CL-1651)", async () => {
    const db = makeMockDb();
    // Interchange continuity model: a launched agent's harness persists its state
    // and resumes it on reconnect (ARCHITECTURE.md "Agent Continuity"). A "deployed"
    // status with an active session means the harness is mid-reconnect, not gone —
    // the hub must not relaunch it.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed" })),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it("passes plaintext apiKey sources directly to launchSession (CL-1521: no decryption)", async () => {
    const db = makeMockDb();
    // Cold start: no active session, so the hub launches and we can inspect sources.
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed", sessionId: null })),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    db.query.credential.findFirst = mock(() =>
      Promise.resolve(ACTIVE_CREDENTIAL),
    );

    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg =
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (sessionService.launchSession as ReturnType<typeof mock>).mock
        .calls[0]![0] as {
        config: { sources: { apiKey: string }[] };
      };
    expect(launchArg.config.sources[0]?.apiKey).toBe(TEST_API_KEY);
  });

  it("does not relaunch a non-running instance when the catalog cannot resolve its model", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve(runningInstance({ status: "deployed" })),
    );
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT_ROW));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    // Catalog resolution yields no sources (no_requirements) — the guard skips relaunch.
    sourcesImpl = () => Promise.resolve([]);

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    await relaunchInstanceIfNeeded(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );

    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });
});

// ─── persistInstanceToolGrants ────────────────────────────────────

describe("persistInstanceToolGrants", () => {
  it("inserts grant rows with correct shape for each tool name", async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    const now = new Date("2026-01-01T00:00:00Z");
    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search", "dispatch"],
      now,
    });

    const rows = insertedRows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenantId).toBe("tenant-1");
      expect(row.principalId).toBe("prn-1");
      expect(row.action).toBe("invoke");
      expect(row.effect).toBe("allow");
      expect(row.origin).toBe("system");
      expect(typeof row.resource).toBe("string");
      expect((row.resource as string).startsWith("tool:")).toBe(true);
      expect(row.roleId).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.createdAt).toEqual(now);
      expect(row.updatedAt).toEqual(now);
    }
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain("tool:exa_search");
    expect(resources).toContain("tool:dispatch");
  });

  it("de-duplicates tool names — duplicate entries produce one row per unique name", async () => {
    const insertedRows: unknown[] = [];
    const valuesMock = mock((rows: unknown) => {
      insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    });
    const insertMock = mock(() => ({ values: valuesMock }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search", "exa_search", "dispatch"],
      now: new Date(),
    });

    const rows = insertedRows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const resources = rows.map((r) => r.resource as string);
    expect(resources).toContain("tool:exa_search");
    expect(resources).toContain("tool:dispatch");
  });

  it("deletes existing system grants before inserting new ones", async () => {
    const ops: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({
        delete: mock(() => {
          ops.push("delete");
          return { where: mock(() => Promise.resolve()) };
        }),
        insert: mock(() => {
          ops.push("insert");
          return { values: mock(() => Promise.resolve()) };
        }),
      }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: ["exa_search"],
      now: new Date(),
    });

    expect(ops[0]).toBe("delete");
    expect(ops[1]).toBe("insert");
  });

  it("skips insert but still deletes when toolNames is empty", async () => {
    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const txMock = mock((fn: (tx: any) => Promise<unknown>) =>
      fn({ insert: insertMock, delete: deleteMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];

    await persistInstanceToolGrants(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      toolNames: [],
      now: new Date(),
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ─── GET /agents (additional branches) ───────────────────────────

describe("GET /agents — personal-agent exclusion", () => {
  it("filters out the caller personal-agent instance from the shared list", async () => {
    const sharedInstance = {
      id: "ins-oat",
      agentId: "agt-oat",
      tenantId: "tenant-1",
      address: "ins-oat@tenant-1.localhost",
      status: "deployed",
      principalId: "prn-agent-oat",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    // The personal exclusion is pushed into the membership query
    // (notInArray(templateKey, personalKeys)), so its result already omits the
    // myra mapping; the instance query is then scoped to the remaining ids.
    db.query.memberAgentInstance.findMany = mock(() =>
      Promise.resolve([{ instanceId: "ins-oat", templateKey: "oat" }]),
    );
    db.query.agentInstance.findMany = mock(() =>
      Promise.resolve([sharedInstance]),
    );
    db.query.agent.findMany = mock(() =>
      Promise.resolve([{ id: "agt-oat", name: "Oat", tenantId: "tenant-1" }]),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/agents?tenantId=tenant-1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe("ins-oat");
    expect(json.data[0].agentName).toBe("Oat");
  });
});

// ─── DELETE /tenants/:tenantId/agents/instances/:instanceId ───────

describe("DELETE /tenants/:tenantId/agents/instances/:instanceId", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "running",
    principalId: "prn-agent-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the instance does not exist", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("stops the instance, removes the mapping, ends the sidecar session, and returns 204", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const setWhere = mock(() => Promise.resolve());
    const setMock = mock(() => ({ where: setWhere }));
    db.update = mock(() => ({ set: setMock }));
    const deleteWhere = mock(() => Promise.resolve());
    db.delete = mock(() => ({ where: deleteWhere }));

    const endSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, endSession };

    const app = buildApp(db, sessionService as unknown as SessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(setMock).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledWith(
      INSTANCE.address,
      "user deleted instance",
    );
  });

  it("still returns 204 when ending the sidecar session rejects", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const sessionService = {
      ...mockSessionService,
      endSession: mock(() => Promise.reject(new Error("sidecar down"))),
    };
    const app = buildApp(db, sessionService as unknown as SessionService);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("soft-deletes by default: stops the instance but never deletes the agent_instance row", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    db.update = mock(() => ({ set: setMock }));
    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances/ins-1", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(setMock).toHaveBeenCalled();
    expect(deletedTables).toContain(memberAgentInstance);
    expect(deletedTables).not.toContain(agentInstanceTable);
  });

  it("hard-deletes an ephemeral workflow instance (ins_ses_ prefix) when hard=true", async () => {
    const ephemeral = { ...INSTANCE, id: "ins_ses_abc-tenant-1" };
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(ephemeral));

    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const endSession = mock(() => Promise.resolve());
    const app = buildApp(db, {
      ...mockSessionService,
      endSession,
    } as unknown as SessionService);
    const res = await app.fetch(
      makeRequest(
        "http://localhost/tenants/tenant-1/agents/instances/ins_ses_abc-tenant-1?hard=true",
        { method: "DELETE" },
      ),
    );
    expect(res.status).toBe(204);
    expect(deletedTables).toContain(memberAgentInstance);
    expect(deletedTables).toContain(agentInstanceTable);
    expect(endSession).toHaveBeenCalledWith(
      ephemeral.address,
      "user deleted instance",
    );
  });

  it("refuses hard delete for a non-ephemeral instance (protects chat history)", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));

    const deletedTables: unknown[] = [];
    db.delete = mock((table: unknown) => {
      deletedTables.push(table);
      return { where: mock(() => Promise.resolve()) };
    });

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest(
        "http://localhost/tenants/tenant-1/agents/instances/ins-1?hard=true",
        { method: "DELETE" },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ephemeral");
    expect(deletedTables).not.toContain(agentInstanceTable);
  });
});

// ─── POST /instances/:instanceId/sessions (additional branches) ───

describe("POST /instances/:instanceId/sessions — branches", () => {
  const INSTANCE = {
    id: "ins-1",
    agentId: "agt-1",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "deployed",
    principalId: "prn-agent-1",
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const AGENT_ROW = {
    id: "agt-1",
    name: "Loop",
    tenantId: "tenant-1",
    systemPrompt: "You are Loop.",
    contextConfig: null,
    initialState: null,
    modelConfig: null,
    capabilities: null,
    credentialRequirements: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };

  it("returns launched:true immediately when the agent is already routable on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const sessionService = {
      ...mockSessionService,
      launchSession: mock(() => Promise.resolve()),
    };
    const app = buildApp(
      db,
      sessionService as unknown as SessionService,
      "user-1",
      makeSidecarRouter([INSTANCE.address]),
    );
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).launched).toBe(true);
    expect(sessionService.launchSession).not.toHaveBeenCalled();
  });

  it("refreshes grants and pushes sendGrantsUpdate when the agent is already routable", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        ...AGENT_ROW,
        capabilities: {
          tools: ["@workbench/tools-granola/granola:granola_list_notes"],
        },
      }),
    );

    const sendGrantsUpdate = mock(() => Promise.resolve());
    const router = makeSidecarRouter([INSTANCE.address], {
      sendGrantsUpdate,
    } as Partial<SidecarRouter>);

    const app = buildApp(db, mockSessionService, "user-1", router);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).launched).toBe(true);
    expect(sendGrantsUpdate).toHaveBeenCalledWith(
      INSTANCE.address,
      expect.any(Array),
    );
  });

  it("returns 409 when the instance was explicitly deleted (stopped with endedAt)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "stopped", endedAt: new Date() }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("deleted");
  });

  it("resets a stopped (not deleted) instance to deployed before launching", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ ...INSTANCE, status: "stopped", endedAt: null }),
    );
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(AGENT_ROW));
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const setWhere = mock(() => Promise.resolve());
    const setMock = mock((_set: { status?: string }) => ({ where: setWhere }));
    db.update = mock(() => ({ set: setMock }));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const resetCall = setMock.mock.calls.find(
      (c) => c[0].status === "deployed",
    );
    expect(resetCall).toBeTruthy();
  });

  it("returns 500 when the tenant has no domain configured", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Tenant configuration");
  });

  it("returns 500 when the agent has no system prompt", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(INSTANCE));
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        name: "Loop",
        tenantId: "tenant-1",
        systemPrompt: null,
      }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/instances/ins-1/sessions", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Agent configuration");
  });
});

// ─── GET /agents/templates ────────────────────────────────────────

describe("GET /agents/templates", () => {
  it("returns deployable, non-personal templates with key/name/description/tools", async () => {
    const app = buildApp(makeMockDb());
    const res = await app.fetch(
      makeRequest("http://localhost/agents/templates"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const keys = json.data.map((t: { key: string }) => t.key);
    expect(keys).toContain("oat");
    // Personal (myra) and non-deployable (loop) templates are excluded.
    expect(keys).not.toContain("myra");
    expect(keys).not.toContain("loop");
    for (const t of json.data) {
      expect(Object.keys(t).sort()).toEqual([
        "description",
        "key",
        "name",
        "tools",
      ]);
      expect(Array.isArray(t.tools)).toBe(true);
    }
  });
});

// ─── POST /tenants/:tenantId/agents/instances (deploy) ────────────

describe("POST /tenants/:tenantId/agents/instances", () => {
  const DEF = {
    id: "agt-def-oat",
    name: "Oat",
    tenantId: "org-tenant",
    systemPrompt: "You are Oat.",
    capabilities: { tools: [] },
    grantRequirements: [],
  };

  function deployDb() {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.query.tenant.findFirst = mock(() => Promise.resolve(TENANT));
    db.query.agent.findFirst = mock(() => Promise.resolve(DEF));
    return db;
  }

  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when templateKey is missing", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: {},
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("templateKey");
  });

  it("returns 400 for an unknown template key", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "does-not-exist" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("non-deployable");
  });

  it("returns 400 for a non-deployable template (loop)", async () => {
    const app = buildApp(deployDb());
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "loop" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when the tenant has no domain configured", async () => {
    const db = deployDb();
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Tenant configuration");
  });

  it("returns 404 when no agent definition is found in the tenant hierarchy", async () => {
    const db = deployDb();
    db.query.agent.findFirst = mock(() => Promise.resolve(undefined));
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("not found");
  });

  it("creates the instance, launches the session, and returns 201", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const inserted: Array<Record<string, unknown>> = [];
    const insertMock = mock(() => ({
      values: mock((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      }),
    }));
    db.insert = insertMock;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: insertMock,
        update: db.update,
        delete: db.delete,
      }),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.created).toBe(true);
    expect(typeof json.instanceId).toBe("string");
    // principal + agentInstance + memberAgentInstance inserted in the transaction.
    expect(inserted.length).toBeGreaterThanOrEqual(3);
  });

  it("grants the caller read/write/manage on the new instance", async () => {
    const db = deployDb();
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    const inserted: Array<Record<string, unknown>> = [];
    const insertMock = mock(() => ({
      values: mock((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      }),
    }));
    db.insert = insertMock;
    db.transaction = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: insertMock, update: db.update, delete: db.delete }),
    );

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);

    const instanceId = (await res.json()).instanceId as string;
    const memberGrants = inserted.filter(
      (row) =>
        row.resource === `instance:${instanceId}` &&
        row.principalId === PRINCIPAL.id &&
        row.effect === "allow",
    );
    expect(memberGrants.map((g) => g.action).sort()).toEqual([
      "manage",
      "read",
      "write",
    ]);
  });

  it("still returns 201 when the post-create session launch fails", async () => {
    const db = deployDb();
    // No sources -> launchAgentSession throws -> caught and logged, route still 201.
    sourcesImpl = () => Promise.resolve([]);
    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).created).toBe(true);
  });

  it("walks up the tenant hierarchy to find the definition in a parent tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);

    // tenant-1 has parent org-tenant. tenant lookups: first the route fetch
    // (tenant-1), then hierarchy walk over org-tenant.
    db.query.tenant.findFirst = mock((args: { where?: unknown }) => {
      void args;
      return Promise.resolve({
        id: "tenant-1",
        domain: "tenant-1.localhost",
        parentId: "org-tenant",
      });
    });
    // Definition only exists under the parent: first agent.findFirst (cursor=org-tenant) hits.
    db.query.agent.findFirst = mock(() => Promise.resolve(DEF));

    const app = buildApp(db);
    const res = await app.fetch(
      makeRequest("http://localhost/tenants/tenant-1/agents/instances", {
        method: "POST",
        body: { templateKey: "oat" },
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ─── launchAgentSession (direct) ──────────────────────────────────

describe("launchAgentSession", () => {
  const BASE_OPTS = {
    agentId: "agt-1",
    instanceId: "ins-1",
    instancePrincipalId: "prn-agent-1",
    tenantId: "tenant-1",
    tenantDomain: "tenant-1.localhost",
    systemPrompt: "You are an agent.",
    now: new Date("2026-01-01T00:00:00Z"),
  };

  function launchDb() {
    const db = makeMockDb();
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: ["exa_search"] },
        credentialRequirements: null,
        modelRequirements: null,
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: null }),
    );
    return db;
  }

  it("throws when there are no resolvable inference sources", async () => {
    sourcesImpl = () => Promise.resolve([]);
    await expect(
      launchAgentSession(
        launchDb() as never,
        mockSessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("No resolvable inference sources");
  });

  it("throws when the agent row is missing", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agent.findFirst = mock(() => Promise.resolve(undefined));
    await expect(
      launchAgentSession(
        db as never,
        mockSessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toThrow("Agent not found");
  });

  it("launches successfully, registers the event collector, and returns address/sessionId", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const createCollector = mock(() => {});
    const eventCollectors = { ...mockEventCollectors, create: createCollector };
    const launchSession = mock(() => Promise.resolve());
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      eventCollectors as never,
      BASE_OPTS,
    );
    expect(result.address).toBe("ins-1@tenant-1.localhost");
    expect(typeof result.sessionId).toBe("string");
    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(createCollector).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a provision-phase SessionLaunchError and rethrows", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const provisionError = new SessionLaunchError(
      "provision",
      new Error("rejected"),
      false,
    );
    const launchSession = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        launchDb() as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("retries after a transient (non-provision) launch failure and then succeeds", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    let calls = 0;
    const launchSession = mock(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new Error("transient network blip"));
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      launchDb() as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    expect(result.sessionId).toBeTruthy();
    expect(launchSession).toHaveBeenCalledTimes(2);
  }, 10000);

  it("reuses the instance existing active session instead of minting a new one (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-existing" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-existing", status: "active" }),
    );
    const insertMock = mock(() => ({ values: mock(() => Promise.resolve()) }));
    db.insert = insertMock;
    let launchedSessionId: string | undefined;
    const launchSession = mock((cfg: { config: { sessionId: string } }) => {
      launchedSessionId = cfg.config.sessionId;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    expect(result.sessionId).toBe("ses-existing");
    expect(launchedSessionId).toBe("ses-existing");
  });

  it("mints a new session when the instance session is not active (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", sessionId: "ses-ended" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ended", status: "ended" }),
    );
    let launchedSessionId: string | undefined;
    const launchSession = mock((cfg: { config: { sessionId: string } }) => {
      launchedSessionId = cfg.config.sessionId;
      return Promise.resolve();
    });
    const sessionService = { ...mockSessionService, launchSession };

    const result = await launchAgentSession(
      db as never,
      sessionService as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      BASE_OPTS,
    );
    expect(result.sessionId).not.toBe("ses-ended");
    expect(result.sessionId.startsWith("ses_")).toBe(true);
    expect(launchedSessionId).toBe(result.sessionId);
  });

  it("stamps endedAt when ending the session after a terminal launch failure (CL-1651)", async () => {
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const db = launchDb();
    const setMock = mock((_set: { status?: string; endedAt?: Date }) => ({
      where: mock(() => Promise.resolve()),
    }));
    db.update = mock(() => ({ set: setMock }));
    const provisionError = new SessionLaunchError(
      "provision",
      new Error("rejected"),
      false,
    );
    const launchSession = mock(() => Promise.reject(provisionError));
    const sessionService = { ...mockSessionService, launchSession };

    await expect(
      launchAgentSession(
        db as never,
        sessionService as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        BASE_OPTS,
      ),
    ).rejects.toBe(provisionError);

    const endedCall = setMock.mock.calls.find((c) => c[0].status === "ended");
    expect(endedCall).toBeTruthy();
    expect(endedCall?.[0].endedAt).toBeInstanceOf(Date);
  });
});

// ─── persistInstanceGrantRequirements ─────────────────────────────

describe("persistInstanceGrantRequirements", () => {
  function captureTx() {
    const insertedRows: Array<Record<string, unknown>> = [];
    const deleteMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    const insertMock = mock(() => ({
      values: mock((rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
        return Promise.resolve();
      }),
    }));
    const txMock = mock((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ delete: deleteMock, insert: insertMock }),
    );
    const db = {
      ...makeMockDb(),
      transaction: txMock,
    } as unknown as import("@intx/db").DB["db"];
    return { db, insertedRows, deleteMock, insertMock };
  }

  it("materializes declared requirements plus the dynamic per-tenant deliver grant", async () => {
    const { db, insertedRows, deleteMock } = captureTx();
    const now = new Date("2026-01-01T00:00:00Z");
    await persistInstanceGrantRequirements(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      grantRequirements: [
        { source: "creator", resource: "tool:mail_send", action: "invoke" },
        {
          source: "invoker",
          resource: "doc:x",
          action: "read",
          effect: "deny",
        },
      ],
      now,
    });

    expect(deleteMock).toHaveBeenCalledTimes(1);
    // 2 declared + 1 dynamic deliver grant.
    expect(insertedRows).toHaveLength(3);

    const creatorRow = insertedRows.find(
      (r) => r.resource === "tool:mail_send",
    );
    expect(creatorRow?.origin).toBe("creator");
    expect(creatorRow?.effect).toBe("allow");

    const invokerRow = insertedRows.find((r) => r.resource === "doc:x");
    expect(invokerRow?.origin).toBe("invoker");
    expect(invokerRow?.effect).toBe("deny");

    const deliver = insertedRows.find((r) => r.action === "deliver");
    expect(deliver?.resource).toBe("tenant:tenant-1");
    expect(deliver?.origin).toBe("invoker");
    expect(deliver?.createdAt).toEqual(now);
  });

  it("always inserts at least the deliver grant when no requirements are declared", async () => {
    const { db, insertedRows } = captureTx();
    await persistInstanceGrantRequirements(db, {
      tenantId: "tenant-1",
      principalId: "prn-1",
      grantRequirements: [],
      now: new Date(),
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.action).toBe("deliver");
  });
});

// ─── relaunchInstanceIfNeeded (additional branches) ───────────────

describe("relaunchInstanceIfNeeded — early returns", () => {
  it("no-ops when the instance does not exist", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance was explicitly deleted (stopped with endedAt)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "stopped",
        endedAt: new Date(),
        address: "ins-1@tenant-1.localhost",
      }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the agent is already routable on the sidecar", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "running",
        endedAt: null,
        address: "ins-1@tenant-1.localhost",
      }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter(["ins-1@tenant-1.localhost"]) as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance already has an active session (sidecar owns it) (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-1",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the instance session is ending (mid-teardown) (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-ending",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ending", status: "ending" }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("relaunches when the instance session is no longer active (CL-1651)", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        principalId: "prn-agent-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: "ses-ended",
      }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-ended", status: "ended" }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        systemPrompt: "You are an agent.",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: [],
        modelRequirements: null,
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the tenant has no domain", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        address: "ins-1@tenant-1.localhost",
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: null }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("no-ops when the agent has no system prompt", async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        address: "ins-1@tenant-1.localhost",
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({ id: "agt-1", systemPrompt: null }),
    );
    const launchSession = mock(() => Promise.resolve());
    await relaunchInstanceIfNeeded(
      db as never,
      { ...mockSessionService, launchSession } as never,
      mockGrantStore as never,
      mockEventCollectors as never,
      "ins-1",
      makeSidecarRouter() as never,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('rethrows a non-"already exists" launch error', async () => {
    const db = makeMockDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({
        id: "ins-1",
        status: "deployed",
        endedAt: null,
        tenantId: "tenant-1",
        agentId: "agt-1",
        principalId: "prn-agent-1",
        address: "ins-1@tenant-1.localhost",
        sessionId: null,
      }),
    );
    db.query.tenant.findFirst = mock(() =>
      Promise.resolve({ id: "tenant-1", domain: "tenant-1.localhost" }),
    );
    db.query.agent.findFirst = mock(() =>
      Promise.resolve({
        id: "agt-1",
        systemPrompt: "You are Loop.",
        contextConfig: null,
        initialState: null,
        modelConfig: null,
        capabilities: { tools: [] },
        credentialRequirements: [],
        modelRequirements: null,
        grantRequirements: [],
        toolPackages: [],
      }),
    );
    sourcesImpl = () =>
      Promise.resolve([{ id: "src-1", apiKey: TEST_API_KEY }]);
    const launchSession = mock(() =>
      Promise.reject(
        new SessionLaunchError("provision", new Error("boom"), false),
      ),
    );

    await expect(
      relaunchInstanceIfNeeded(
        db as never,
        { ...mockSessionService, launchSession } as never,
        mockGrantStore as never,
        mockEventCollectors as never,
        "ins-1",
        makeSidecarRouter() as never,
      ),
    ).rejects.toThrow("boom");
  });
});

// ─── reconcileDisconnectedSession ─────────────────────────────────
//
// When a sidecar fully restarts (every redeploy) it connects fresh with no
// agents, so the address it previously routed never reconnects. Interchange's
// orchestrator only abandons the event collector on sidecar.disconnect; it
// leaves agent_session.status = 'active' so a transient reconnect can resume.
// Nothing reconciles the DB when the reconnect never comes, leaving Myra wedged
// (active session, unroutable address) — relaunchInstanceIfNeeded then returns
// early forever. This reconcile is the host-side cleanup that retires the
// manual reset-myra ritual. (CL-1692)

function makeUpdateCapture() {
  const calls: Array<Record<string, unknown>> = [];
  const update = mock(() => ({
    set: mock((values: Record<string, unknown>) => {
      calls.push(values);
      return { where: mock(() => Promise.resolve()) };
    }),
  }));
  return { update, calls };
}

describe("reconcileDisconnectedSession", () => {
  const ADDR = "ins-1@tenant-1.localhost";

  it("no-ops when no instance is found for the address", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() => Promise.resolve(undefined));

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the address became routable again (sidecar reconnected)", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter([ADDR]) as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the instance has no session", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: null }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("no-ops when the session is already ended", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "ended" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(0);
  });

  it("marks an active session ended when the address never reconnected", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("marks an ending session ended (a dead sidecar never completes teardown)", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "ending" }),
    );

    await reconcileDisconnectedSession(
      db as never,
      makeSidecarRouter() as never,
      ADDR,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
  });
});

describe("registerDisconnectReconciler", () => {
  const ADDR = "ins-1@tenant-1.localhost";

  function makeEventRouter(routable: string[] = []) {
    let disconnectListener:
      | ((p: { agentAddresses: string[] }) => void)
      | undefined;
    const router = {
      getRoutableAddresses: mock(() => routable),
      events: {
        on: mock(
          (
            type: string,
            listener: (p: { agentAddresses: string[] }) => void,
          ) => {
            if (type === "sidecar.disconnect") disconnectListener = listener;
            return () => {};
          },
        ),
      },
    } as unknown as SidecarRouter;
    return {
      router,
      fire: (addrs: string[]) =>
        disconnectListener?.({ agentAddresses: addrs }),
    };
  }

  it("subscribes to sidecar.disconnect and reconciles after the grace window", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const { router, fire } = makeEventRouter([]);

    registerDisconnectReconciler({ db: db as never, router, graceMs: 1 });
    fire([ADDR]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("ended");
  });

  it("does not reconcile when the address reconnected within the grace window", async () => {
    const db = makeMockDb();
    const { update, calls } = makeUpdateCapture();
    db.update = update;
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ id: "ins-1", address: ADDR, sessionId: "ses-1" }),
    );
    db.query.agentSession.findFirst = mock(() =>
      Promise.resolve({ id: "ses-1", status: "active" }),
    );
    const { router, fire } = makeEventRouter([ADDR]);

    registerDisconnectReconciler({ db: db as never, router, graceMs: 1 });
    fire([ADDR]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(calls).toHaveLength(0);
  });
});
