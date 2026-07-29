/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  deleteAgentInstance,
  deployAgentFromTemplate,
  getMe,
  postMe,
  patchMeProfile,
  ensureMeSynced,
  invalidateMeSyncCache,
  getMyPrincipals,
  getAnalyticsSummary,
  getOutputFeedback,
  getOwnerWorkUnitHealth,
  getOwnerDeadWorkUnits,
  launchInstanceSession,
  listAgentInstances,
  listAgentTemplates,
  listWorkbenches,
  principalsToWorkbenches,
  principalToWorkbenchEntry,
  stopAgentInstance,
  parseActivityOverview,
  upsertRating,
  type Principal,
  type SavedRating,
} from "./hub-api";

describe("principalsToWorkbenches", () => {
  it("filters out the global org tenant by id", () => {
    const principals: Principal[] = [
      {
        principalId: "p-global",
        tenantId: "tenant-global",
        tenantSlug: "example-org",
        tenantName: "Example Org",
        kind: "user",
        status: "active",
        roles: [],
      },
      {
        principalId: "p-wb",
        tenantId: "tenant-acme",
        tenantSlug: "acme-sales",
        tenantName: "Acme Sales",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, ["tenant-global"]);

    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe("p-wb");
    expect(workbenches[0]!.tenantName).toBe("Acme Sales");
  });

  it("returns empty list when user has only the global org tenant", () => {
    const principals: Principal[] = [
      {
        principalId: "p-global",
        tenantId: "tenant-global",
        tenantSlug: "example-org",
        tenantName: "Example Org",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, ["tenant-global"]);
    expect(workbenches).toHaveLength(0);
  });

  it("returns all principals when globalTenantId is null", () => {
    const principals: Principal[] = [
      {
        principalId: "p-1",
        tenantId: "tenant-acme",
        tenantSlug: "acme-sales",
        tenantName: "Acme Sales",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, [null]);
    expect(workbenches).toHaveLength(1);
  });

  it("maps Interchange principalId to the workbench entry id", () => {
    const principal: Principal = {
      principalId: "principal-workbench",
      tenantId: "tenant-acme",
      tenantSlug: "acme-sales",
      tenantName: "Acme Sales",
      kind: "user",
      status: "active",
      roles: [],
    };

    expect(principalToWorkbenchEntry(principal)).toEqual({
      id: "principal-workbench",
      tenantId: "tenant-acme",
      tenantSlug: "acme-sales",
      tenantName: "Acme Sales",
    });
  });
});

// Network helpers run through the real hubFetch by stubbing the global fetch
// boundary — no module mocking, so nothing leaks into other files (bun's
// mock.module is process-wide and survives mock.restore).
const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  body?: unknown;
  bodyThrows?: boolean;
}

function installFetch(routes: (url: string) => StubResponse): FetchCall[] {
  const calls: FetchCall[] = [];
  const stub = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes(url);
    const res = {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === "content-length"
            ? (r.contentLength ?? null)
            : null,
      },
      json: () =>
        r.bodyThrows
          ? Promise.reject(new Error("not json"))
          : Promise.resolve(r.body),
    };
    return Promise.resolve(res as unknown as Response);
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return calls;
}

describe("hub-api network helpers", () => {
  beforeEach(() => {
    (
      globalThis as unknown as {
        window: { happyDOM: { setURL: (u: string) => void } };
      }
    ).window.happyDOM.setURL("http://localhost/");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateMeSyncCache();
  });

  it("getMe issues a credentialed GET to /api/v1/me and returns the parsed body", async () => {
    const me = { userId: "u1", userName: "Sawyer" };
    const calls = installFetch(() => ({ body: me }));

    expect((await getMe()) as unknown).toEqual(me);
    expect(calls[0]!.url).toContain("/api/v1/me");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("getMe parses preferences at the boundary and degrades garbage to {}", async () => {
    installFetch(() => ({
      body: {
        userId: "u1",
        userName: "Sawyer",
        preferences: { theme: "not-a-theme" },
      },
    }));
    const me = await getMe();
    expect(me.preferences).toEqual({});
  });

  it("getMe keeps a valid preferences blob intact", async () => {
    installFetch(() => ({
      body: {
        userId: "u1",
        userName: "Sawyer",
        preferences: { theme: "notion", compactToolActivity: true },
      },
    }));
    const me = await getMe();
    expect(me.preferences).toEqual({
      theme: "notion",
      compactToolActivity: true,
    });
  });

  it("getMe keeps a favoriteWorkflows array in preferences", async () => {
    installFetch(() => ({
      body: {
        userId: "u1",
        userName: "Sawyer",
        preferences: { favoriteWorkflows: ["attio-task-agent", "last30days"] },
      },
    }));
    const me = await getMe();
    expect(me.preferences).toEqual({
      favoriteWorkflows: ["attio-task-agent", "last30days"],
    });
  });

  it("ensureMeSynced GETs first and POSTs only when personalAgentSyncAvailable", async () => {
    const stale = { userId: "u1", personalAgentSyncAvailable: true };
    const fresh = { userId: "u1", personalAgentSyncAvailable: false };
    let call = 0;
    const calls = installFetch(() => {
      call += 1;
      if (call === 1) return { body: stale };
      return { body: fresh };
    });

    expect((await ensureMeSynced()) as unknown).toEqual(fresh);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.init?.method).toBe("POST");
  });

  it("ensureMeSynced memoizes: a second call reuses the first result without refetching", async () => {
    const fresh = { userId: "u1", personalAgentSyncAvailable: false };
    const calls = installFetch(() => ({ body: fresh }));

    await ensureMeSynced();
    await ensureMeSynced();

    expect(calls).toHaveLength(1);
  });

  it("ensureMeSynced refetches after invalidateMeSyncCache", async () => {
    const fresh = { userId: "u1", personalAgentSyncAvailable: false };
    const calls = installFetch(() => ({ body: fresh }));

    await ensureMeSynced();
    invalidateMeSyncCache();
    await ensureMeSynced();

    expect(calls).toHaveLength(2);
  });

  it("ensureMeSynced does not cache a failed sync — the next call retries", async () => {
    let call = 0;
    installFetch(() => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, body: {} };
      return { body: { userId: "u1", personalAgentSyncAvailable: false } };
    });

    await expect(ensureMeSynced()).rejects.toThrow();
    await expect(ensureMeSynced()).resolves.toEqual({
      userId: "u1",
      personalAgentSyncAvailable: false,
    });
  });

  it("a 401 from any hub call invalidates the ensureMeSynced cache", async () => {
    let call = 0;
    const calls = installFetch(() => {
      call += 1;
      if (call === 1) return { body: { userId: "u1", userName: "Sawyer" } };
      if (call === 2) return { ok: false, status: 401, body: {} };
      return { body: { userId: "u1", personalAgentSyncAvailable: false } };
    });

    await ensureMeSynced();
    await getMe().catch(() => {});
    await ensureMeSynced();

    expect(calls).toHaveLength(3);
  });

  it("postMe issues a credentialed POST to /api/v1/me with JSON body", async () => {
    const me = { userId: "u1", userName: "Sawyer", provisioned: true };
    const calls = installFetch(() => ({ body: me }));

    expect((await postMe({ syncPersonalAgent: true })) as unknown).toEqual(me);
    expect(calls[0]!.url).toContain("/api/v1/me");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ syncPersonalAgent: true }),
    );
  });

  it("patchMeProfile PATCHes the display name to /api/v1/me/profile", async () => {
    const calls = installFetch(() => ({ body: { userName: "Sawyer C" } }));

    expect((await patchMeProfile("Sawyer C")) as unknown).toEqual({
      userName: "Sawyer C",
    });
    expect(calls[0]!.url).toContain("/api/v1/me/profile");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ displayName: "Sawyer C" }),
    );
  });

  it("getMyPrincipals unwraps the data envelope", async () => {
    const data = [{ principalId: "p1" }];
    const calls = installFetch(() => ({ body: { data } }));

    expect((await getMyPrincipals()) as unknown).toEqual(data);
    expect(calls[0]!.url).toContain("/api/me/principals");
  });

  it("listWorkbenches keeps the working/global-org tenant first and excludes other root tenants", async () => {
    installFetch((url) => {
      if (url.includes("/me/principals")) {
        return {
          body: {
            data: [
              {
                principalId: "p-acme",
                tenantId: "t-acme",
                tenantSlug: "s",
                tenantName: "Acme",
              },
              {
                principalId: "p-root",
                tenantId: "t-root",
                tenantSlug: "org",
                tenantName: "Global",
              },
              {
                principalId: "p-legacy",
                tenantId: "t-legacy",
                tenantSlug: "legacy",
                tenantName: "Legacy",
              },
            ],
          },
        };
      }
      return {
        body: {
          rootTenantIds: ["t-root", "t-legacy"],
          personalTenantId: "t-root",
        },
      };
    });

    const workbenches = await listWorkbenches();
    // The working/global-org tenant (t-root) is selectable and listed first as
    // the default; the legacy root tenant (t-legacy) is excluded; the sub-tenant
    // (t-acme) is kept.
    expect(workbenches.map((w) => w.tenantId)).toEqual(["t-root", "t-acme"]);
  });

  it("listWorkbenches returns the working tenant for a root-only user", async () => {
    installFetch((url) => {
      if (url.includes("/me/principals")) {
        return {
          body: {
            data: [
              {
                principalId: "p-root",
                tenantId: "t-root",
                tenantSlug: "org",
                tenantName: "Global",
              },
            ],
          },
        };
      }
      return {
        body: { rootTenantIds: ["t-root"], personalTenantId: "t-root" },
      };
    });

    const workbenches = await listWorkbenches();
    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.tenantId).toBe("t-root");
  });

  it("listWorkbenches excludes legacy root tenants when there is no working tenant", async () => {
    installFetch((url) => {
      if (url.includes("/me/principals")) {
        return {
          body: {
            data: [
              { principalId: "p-root", tenantId: "t-root" },
              {
                principalId: "p-acme",
                tenantId: "t-acme",
                tenantSlug: "s",
                tenantName: "Acme",
              },
            ],
          },
        };
      }
      return { body: { rootTenantIds: ["t-root"], personalTenantId: null } };
    });

    const workbenches = await listWorkbenches();
    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe("p-acme");
  });

  it("listAgentInstances encodes the tenantId query parameter", async () => {
    const calls = installFetch(() => ({ body: { data: [{ id: "inst-1" }] } }));

    const instances = await listAgentInstances("tenant/with space");
    expect(instances as unknown).toEqual([{ id: "inst-1" }]);
    expect(calls[0]!.url).toContain(
      `tenantId=${encodeURIComponent("tenant/with space")}`,
    );
  });

  it("deleteAgentInstance issues a DELETE and tolerates a 204 with no body", async () => {
    const calls = installFetch(() => ({
      status: 204,
      contentLength: "0",
      body: undefined,
    }));

    await deleteAgentInstance("t1", "inst-1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.url).toContain(
      "/api/v1/tenants/t1/agents/instances/inst-1",
    );
  });

  it("launchInstanceSession POSTs an empty object body", async () => {
    const calls = installFetch(() => ({
      body: { launched: true, sessionId: "ses-9" },
    }));

    expect(await launchInstanceSession("inst-9")).toEqual({
      launched: true,
      sessionId: "ses-9",
    });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
  });

  it("launchInstanceSession single-flights concurrent ensures per instance (CL-4688)", async () => {
    let resolveBody!: (value: unknown) => void;
    const bodyPromise = new Promise((resolve) => {
      resolveBody = resolve;
    });
    let fetchCalls = 0;
    const calls: FetchCall[] = [];
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      fetchCalls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => bodyPromise,
      });
    }) as unknown as typeof fetch;

    const a = launchInstanceSession("inst-shared");
    const b = launchInstanceSession("inst-shared");
    await Promise.resolve();
    expect(fetchCalls).toBe(1);

    resolveBody({ launched: true, sessionId: "ses-shared" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ launched: true, sessionId: "ses-shared" });
    expect(rb).toEqual({ launched: true, sessionId: "ses-shared" });
    expect(calls).toHaveLength(1);

    // After settle, a new ensure is allowed.
    installFetch(() => ({
      body: { launched: true, sessionId: "ses-next" },
    }));
    expect(await launchInstanceSession("inst-shared")).toEqual({
      launched: true,
      sessionId: "ses-next",
    });
  });

  it("launchInstanceSession sends pageContext on chat open (CL-3527)", async () => {
    const calls = installFetch(() => ({
      body: { launched: true, sessionId: "ses-9" },
    }));

    await launchInstanceSession("inst-9", {
      pageContext: "Inbox home: triage feed.",
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      pageContext: "Inbox home: triage feed.",
    });
  });

  it("launchInstanceSession rejects a success body missing sessionId", async () => {
    installFetch(() => ({ body: { launched: true } }));
    await expect(launchInstanceSession("inst-9")).rejects.toThrow(
      /Invalid launch instance session response/,
    );
  });

  it("stopAgentInstance DELETEs the instance", async () => {
    const calls = installFetch(() => ({ status: 204, contentLength: "0" }));

    await stopAgentInstance("t1", "inst-2");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("listAgentTemplates unwraps the data envelope", async () => {
    installFetch(() => ({ body: { data: [{ key: "myra" }] } }));
    expect((await listAgentTemplates()) as unknown).toEqual([{ key: "myra" }]);
  });

  it("deployAgentFromTemplate POSTs the templateKey", async () => {
    const calls = installFetch(() => ({
      body: { instanceId: "i1", created: true },
    }));

    await deployAgentFromTemplate("t1", "oat");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      templateKey: "oat",
    });
  });

  it("getAnalyticsSummary validates the response and passes date query params", async () => {
    const summary = {
      tenantId: "t1",
      turnCount: 10,
      failedTurnCount: 1,
      toolCallCount: 5,
      toolErrorCount: 0,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    };
    const calls = installFetch(() => ({ body: summary }));

    await expect(
      getAnalyticsSummary("t1", { startDate: "2026-06-01" }),
    ).resolves.toEqual(summary);
    expect(calls[0]!.url).toContain("/api/tenants/t1/analytics/summary");
    expect(calls[0]!.url).toContain("startDate=2026-06-01");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("getAnalyticsSummary rejects malformed responses", async () => {
    installFetch(() => ({ body: { tenantId: "t1", turnCount: "nope" } }));

    await expect(getAnalyticsSummary("t1")).rejects.toThrow(
      /Invalid analytics summary response/,
    );
  });

  it("getOutputFeedback parses the ratings envelope and returns the array", async () => {
    const ratings = [
      { subjectId: "tp-1", subjectKind: "turn_part", rating: 1 },
      { subjectId: "step-2", subjectKind: "workflow_step", rating: -1 },
    ];
    const calls = installFetch(() => ({ body: { ratings } }));

    expect(await getOutputFeedback("inst-1")).toEqual(ratings as SavedRating[]);
    expect(calls[0]!.url).toContain("/api/v1/instances/inst-1/feedback");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("getOutputFeedback rejects when the response fails schema validation", async () => {
    installFetch(() => ({
      body: {
        ratings: [{ subjectId: "tp-1", subjectKind: "turn_part", rating: 7 }],
      },
    }));

    await expect(getOutputFeedback("inst-1")).rejects.toThrow(
      /Malformed feedback response/,
    );
  });

  it("getOutputFeedback rejects when the envelope shape is wrong", async () => {
    installFetch(() => ({ body: { notRatings: [] } }));

    await expect(getOutputFeedback("inst-1")).rejects.toThrow(
      /Malformed feedback response/,
    );
  });

  it("getOwnerWorkUnitHealth parses a well-formed health payload", async () => {
    const health = {
      byStatus: { pending: 2, dead: 1 },
      oldestPendingAgeMs: 1500,
      deadCount: 1,
      agedLeasedCount: 0,
    };
    installFetch(() => ({ body: health }));

    await expect(getOwnerWorkUnitHealth()).resolves.toEqual(health);
  });

  it("getOwnerWorkUnitHealth rejects a malformed health payload", async () => {
    installFetch(() => ({
      body: { byStatus: { pending: 2 }, deadCount: "nope" },
    }));

    await expect(getOwnerWorkUnitHealth()).rejects.toThrow(
      /Malformed \/owner\/work-units\/health response/,
    );
  });

  it("getOwnerDeadWorkUnits parses the items envelope", async () => {
    const items = [
      {
        id: "wu_1",
        tenantId: "t1",
        kind: "granola_call",
        idempotencyKey: "key-1",
        status: "dead",
        attempts: 3,
        lastError: "boom",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    ];
    installFetch(() => ({ body: { items } }));

    await expect(getOwnerDeadWorkUnits()).resolves.toEqual(items);
  });

  it("getOwnerDeadWorkUnits rejects a malformed items envelope", async () => {
    installFetch(() => ({
      body: { items: [{ id: "wu_1", status: "dead" }] },
    }));

    await expect(getOwnerDeadWorkUnits()).rejects.toThrow(
      /Malformed \/owner\/work-units\/dead response/,
    );
  });

  it("throws with the server error message and status on a non-ok response", async () => {
    installFetch(() => ({
      ok: false,
      status: 403,
      body: { error: "forbidden" },
    }));

    await expect(getMe()).rejects.toMatchObject({
      message: "forbidden",
      status: 403,
    });
  });

  it("throws with nested error.message from structured hub errors", async () => {
    installFetch(() => ({
      ok: false,
      status: 500,
      body: {
        error: { code: "internal_error", message: "Failed to query analytics" },
      },
    }));

    await expect(getAnalyticsSummary("tenant-1")).rejects.toMatchObject({
      message: "Failed to query analytics",
      status: 500,
    });
  });

  it("throws an HTTP fallback message when the error body is not JSON", async () => {
    installFetch(() => ({ ok: false, status: 500, bodyThrows: true }));

    await expect(getMe()).rejects.toMatchObject({
      message: "HTTP 500",
      status: 500,
    });
  });
});

describe("upsertRating", () => {
  it("appends a rating when none exists for the subject", () => {
    const next: SavedRating = {
      subjectId: "tp-1",
      subjectKind: "turn_part",
      rating: 1,
    };
    expect(upsertRating([], next)).toEqual([next]);
    expect(upsertRating(undefined, next)).toEqual([next]);
  });

  it("replaces the existing rating for the same subject without duplicating", () => {
    const prev: SavedRating[] = [
      { subjectId: "tp-1", subjectKind: "turn_part", rating: 1 },
    ];
    const next: SavedRating = {
      subjectId: "tp-1",
      subjectKind: "turn_part",
      rating: -1,
    };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(1);
    expect(result[0]!.rating).toBe(-1);
  });

  it("treats a different subjectKind for the same id as a distinct subject", () => {
    const prev: SavedRating[] = [
      { subjectId: "s-1", subjectKind: "turn_part", rating: 1 },
    ];
    const next: SavedRating = {
      subjectId: "s-1",
      subjectKind: "workflow_step",
      rating: 1,
    };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(2);
  });

  it("leaves other subjects untouched", () => {
    const prev: SavedRating[] = [
      { subjectId: "tp-1", subjectKind: "turn_part", rating: 1 },
      { subjectId: "tp-2", subjectKind: "turn_part", rating: 1 },
    ];
    const next: SavedRating = {
      subjectId: "tp-1",
      subjectKind: "turn_part",
      rating: -1,
    };

    const result = upsertRating(prev, next);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.subjectId === "tp-2")!.rating).toBe(1);
  });
});

describe("parseActivityOverview (CL-2891)", () => {
  const inference = {
    summary: {
      tenantId: "t1",
      turnCount: 0,
      failedTurnCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    previousSummary: null,
    byAgent: [],
    byInstance: [],
  };

  const base = {
    tenantId: "t1",
    range: {},
    artifacts: {
      total: 0,
      createdInRange: 0,
      byStatus: [],
      byKind: [],
    },
    workflowRuns: {
      executionRecords: 0,
      executionsStartedInRange: 0,
      activeExecutions: 0,
      byStatus: [],
      byKind: [],
      deploymentsIndexed: 0,
    },
    agentInstances: { active: 0, startedInRange: 0, endedInRange: 0, total: 0 },
    agentActivity: { active: 0, idle: 0 },
    conversations: { total: 0, createdInRange: 0 },
    messages: { total: 0, createdInRange: 0 },
    dailySeries: [],
    metricsBucket: "week" as const,
    metricsSeries: [],
    models: [],
    byModel: [],
    tokensRecordedFrom: null,
    byPerson: [],
    byWorkflowType: [
      {
        kind: "demo",
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 1,
        outputTokens: 2,
        cost: null,
      },
    ],
    inference,
  };

  it("accepts payloads missing pricedByModel and workflow cache fields", () => {
    const parsed = parseActivityOverview(base);
    expect(parsed.pricedByModel).toBeNull();
    expect(parsed.byWorkflowType[0]!.cacheReadTokens).toBe(0);
    expect(parsed.byWorkflowType[0]!.cacheWriteTokens).toBe(0);
    expect(parsed.byWorkflowType[0]!.thinkingTokens).toBe(0);
  });

  it("accepts explicit pricedByModel null and preserves hub-priced payloads", () => {
    const priced = {
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
        total: 3,
      },
      unpricedModels: [] as string[],
      hasUnpriced: false,
    };
    const withHub = parseActivityOverview({
      ...base,
      pricedByModel: priced,
      byWorkflowType: [
        {
          kind: "demo",
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          thinkingTokens: 5,
          cost: priced,
        },
      ],
    });
    expect(withHub.pricedByModel?.cost.total).toBe(3);
    expect(withHub.byWorkflowType[0]!.cacheWriteTokens).toBe(4);

    const explicitNull = parseActivityOverview({
      ...base,
      pricedByModel: null,
    });
    expect(explicitNull.pricedByModel).toBeNull();
  });
});
