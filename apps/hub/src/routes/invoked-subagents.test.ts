import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

const listInvokedSubagents = mock<(...args: unknown[]) => Promise<unknown>>(
  () => Promise.resolve([]),
);
type ContextResult = {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
};
const getRequestedUserContext = mock<
  (
    db: unknown,
    userId: string,
    tenantId?: string | null,
  ) => Promise<ContextResult>
>(() =>
  Promise.resolve({
    context: { tenantId: "tn-global", principalId: "prn-member" },
    forbidden: false,
  }),
);

mock.module("../services/invoked-subagents", () => ({
  listInvokedSubagents,
}));
mock.module("../lib/user-context", () => ({
  getRequestedUserContext,
}));

const { createInvokedSubagentsRouter } = await import("./invoked-subagents");

function wrapWithAuth(router: Hono, userId = "usr-1"): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, userId);
    await next();
  });
  app.route("/", router);
  return app;
}

function buildRouter(): Hono {
  return createInvokedSubagentsRouter({} as never) as unknown as Hono;
}

describe("invoked-subagents router", () => {
  beforeEach(() => {
    listInvokedSubagents.mockClear();
    getRequestedUserContext.mockClear();
    getRequestedUserContext.mockResolvedValue({
      context: { tenantId: "tn-global", principalId: "prn-member" },
      forbidden: false,
    });
    listInvokedSubagents.mockResolvedValue([]);
  });

  it("forwards the request tenantId to context resolution (regression: null tenant crash)", async () => {
    await wrapWithAuth(buildRouter()).request(
      "/invoked-subagents?tenantId=tnt_abc",
    );
    expect(getRequestedUserContext).toHaveBeenCalledWith(
      expect.anything(),
      "usr-1",
      "tnt_abc",
    );
  });

  it("lists invoked subagents for the resolved member", async () => {
    listInvokedSubagents.mockResolvedValueOnce([
      {
        mappingId: "map-1",
        agentId: "agt-1",
        agentName: "Research",
        instanceId: "inst-1",
        instanceAddress: "inst-1@acme.test",
        sessionId: "ses-1",
        sessionStatus: "active",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        firstInvokedAt: "2026-01-01T00:00:00.000Z",
        lastInvokedAt: "2026-01-02T00:00:00.000Z",
        originConversationId: null,
      },
    ]);

    const res = await wrapWithAuth(buildRouter()).request("/invoked-subagents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subagents).toHaveLength(1);
    expect(listInvokedSubagents).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
    });
  });

  it("passes originConversationId filter when provided", async () => {
    await wrapWithAuth(buildRouter()).request(
      "/invoked-subagents?originConversationId=thread-42",
    );
    expect(listInvokedSubagents).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      originConversationId: "thread-42",
    });
  });

  it("returns a structured 500 instead of throwing when listInvokedSubagents fails", async () => {
    listInvokedSubagents.mockRejectedValueOnce(new Error("query boom"));

    const res = await wrapWithAuth(buildRouter()).request("/invoked-subagents");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns a structured 500 when context resolution fails", async () => {
    getRequestedUserContext.mockRejectedValueOnce(new Error("context boom"));

    const res = await wrapWithAuth(buildRouter()).request("/invoked-subagents");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 for invalid query", async () => {
    const res = await wrapWithAuth(buildRouter()).request(
      `/invoked-subagents?originConversationId=${"x".repeat(257)}`,
    );
    expect(res.status).toBe(400);
    expect(listInvokedSubagents).not.toHaveBeenCalled();
  });

  it("returns 401 without user", async () => {
    const app = new Hono();
    app.route("/", buildRouter());
    const res = await app.request("/invoked-subagents");
    expect(res.status).toBe(401);
  });

  it("returns 403 when member context cannot be resolved", async () => {
    getRequestedUserContext.mockResolvedValueOnce({
      context: null,
      forbidden: false,
    });
    const res = await wrapWithAuth(buildRouter()).request("/invoked-subagents");
    expect(res.status).toBe(403);
  });

  it("returns 403 when the requested tenant is forbidden", async () => {
    getRequestedUserContext.mockResolvedValueOnce({
      context: null,
      forbidden: true,
    });
    const res = await wrapWithAuth(buildRouter()).request(
      "/invoked-subagents?tenantId=tnt_other",
    );
    expect(res.status).toBe(403);
  });
});
