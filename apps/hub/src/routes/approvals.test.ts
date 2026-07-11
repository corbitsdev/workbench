import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import {
  createApprovalsRouter,
  createInternalApprovalsRouter,
} from "./approvals";

// Response.json() is Promise<unknown> under lib ESNext; assertions cast to the
// expected body shape — a wrong shape fails the expect() at runtime.
type ResBody = {
  id: string;
  status: string;
  sessionId: string;
  message: string;
  error: string;
  context: Record<string, unknown>;
};

const PRINCIPAL = {
  id: "prn-1",
  tenantId: "tenant-1",
  kind: "user",
  refId: "user-1",
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockDb(overrides: Record<string, any> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const base: any = {
    query: {
      principal: {
        findFirst: mock(() => Promise.resolve(undefined)),
      },
    },
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
      })),
    })),
    ...overrides,
  };
  return base;
}

function buildApp(db: ReturnType<typeof makeMockDb>, userId = "user-1") {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  parent.route("/", createApprovalsRouter(db));
  return parent;
}

type ApprovalRow = {
  id: string;
  tenantId: string;
  principalId: string;
  status: string;
};

// Builds a db whose approve/reject flow (fetch the approval, then authorize via
// instance ownership, then update) is driven by an explicit ownership graph.
// biome-ignore lint/suspicious/noExplicitAny: test mock
function resolveDb(opts: {
  row: ApprovalRow | null;
  callerPrincipal?: { id: string } | null;
  instance?: { id: string; tenantId: string } | null;
  ownership?: { memberPrincipalId: string } | null;
  updated?: Record<string, unknown> | null;
  onSet?: (vals: Record<string, unknown>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
}): any {
  const db = makeMockDb();
  db.select = mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(() => Promise.resolve(opts.row ? [opts.row] : [])),
      })),
    })),
  }));
  db.query.principal = {
    findFirst: mock(() => Promise.resolve(opts.callerPrincipal ?? undefined)),
  };
  db.query.agentInstance = {
    findFirst: mock(() => Promise.resolve(opts.instance ?? undefined)),
  };
  db.query.memberAgentInstance = {
    findFirst: mock(() => Promise.resolve(opts.ownership ?? undefined)),
  };
  db.update = mock(() => ({
    set: mock((vals: Record<string, unknown>) => {
      opts.onSet?.(vals);
      return {
        where: mock(() => ({
          returning: mock(() =>
            Promise.resolve(opts.updated ? [opts.updated] : []),
          ),
        })),
      };
    }),
  }));
  return db;
}

// An approval created by a Myra agent: its principalId is the agent's synthetic
// instance principal, distinct from the owning user's principal.
const OWNED_APPROVAL: ApprovalRow = {
  id: "apr-1",
  tenantId: "tenant-1",
  principalId: "agent-prn",
  status: "pending",
};
const OWNER_PRINCIPAL = { id: "user-prn" };
const OWNED_INSTANCE = { id: "ins-1", tenantId: "tenant-1" };
const OWNERSHIP = { memberPrincipalId: "user-prn" };

describe("GET /tenants/:tenantId/approvals", () => {
  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = makeMockDb();
    // principal.findFirst returns undefined — caller not in tenant
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-other/approvals", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("Forbidden");
  });

  it("returns 200 with pending approvals when the caller is in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const pendingApproval = {
      id: "apr-1",
      tenantId: "tenant-1",
      principalId: PRINCIPAL.id,
      agentId: "agt-1",
      sessionId: null,
      resource: "file:/path/to/file",
      action: "read",
      status: "pending",
      context: null,
      message: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([pendingApproval])),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody[];
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0]?.id).toBe("apr-1");
  });
});

// The route tests below mock `db` (the hub convention — see the note in
// feedback.test.ts; there is no real-Postgres route harness). They exercise the
// authorization control flow against an explicit ownership graph. The seam they
// cannot cover is the live one: the sidecar writes the agent's synthetic
// instance principal, and the hub must map it back to the owning user. That
// mapping is verified here via the ownership graph, and the principal-identity
// chain it relies on (agent instance principal -> memberAgentInstance owner) is
// established by tracing the approval principal identities; a real-DB
// integration test is the remaining gap.
function resolvedRow(status: string, message: string | null = null) {
  return {
    id: "apr-1",
    tenantId: "tenant-1",
    principalId: "agent-prn",
    agentId: "agt-1",
    sessionId: "ses-1",
    resource: "tool:notion__create_page",
    action: "Run notion__create_page",
    context: null,
    status,
    message,
    resolvedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("POST /tenants/:tenantId/approvals/:approvalId/approve", () => {
  it("approves when the caller owns the agent instance that created it", async () => {
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: OWNER_PRINCIPAL,
      instance: OWNED_INSTANCE,
      ownership: OWNERSHIP,
      updated: resolvedRow("approved"),
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.status).toBe("approved");
  });

  it("approves when the approval targets the caller's own principal directly", async () => {
    const db = resolveDb({
      row: { ...OWNED_APPROVAL, principalId: "user-prn" },
      callerPrincipal: OWNER_PRINCIPAL,
      updated: resolvedRow("approved"),
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 when a co-tenant non-owner tries to approve", async () => {
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: { id: "other-prn" },
      instance: OWNED_INSTANCE,
      ownership: null,
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no principal in the tenant", async () => {
    const db = resolveDb({ row: OWNED_APPROVAL, callerPrincipal: null });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the approval principal maps to no instance", async () => {
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: { id: "other-prn" },
      instance: null,
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the approval does not exist", async () => {
    const db = resolveDb({ row: null, callerPrincipal: OWNER_PRINCIPAL });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-1/approvals/apr-missing/approve",
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 (not a 404 existence oracle) for a non-member", async () => {
    const db = resolveDb({ row: null, callerPrincipal: null });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-1/approvals/apr-missing/approve",
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when the approval is already resolved", async () => {
    const db = resolveDb({
      row: { ...OWNED_APPROVAL, status: "approved" },
      callerPrincipal: OWNER_PRINCIPAL,
      instance: OWNED_INSTANCE,
      ownership: OWNERSHIP,
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 when the row is resolved between the check and the update", async () => {
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: OWNER_PRINCIPAL,
      instance: OWNED_INSTANCE,
      ownership: OWNERSHIP,
      updated: null,
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /tenants/:tenantId/approvals/:approvalId/reject", () => {
  it("rejects when the caller owns the instance and persists the message", async () => {
    const setValues: Record<string, unknown>[] = [];
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: OWNER_PRINCIPAL,
      instance: OWNED_INSTANCE,
      ownership: OWNERSHIP,
      updated: resolvedRow("rejected", "Not allowed"),
      onSet: (vals) => setValues.push(vals),
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Not allowed" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.status).toBe("rejected");
    expect(setValues[0]).toMatchObject({
      status: "rejected",
      message: "Not allowed",
    });
  });

  it("stores a null message when the reject body omits one", async () => {
    const setValues: Record<string, unknown>[] = [];
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: OWNER_PRINCIPAL,
      instance: OWNED_INSTANCE,
      ownership: OWNERSHIP,
      updated: resolvedRow("rejected"),
      onSet: (vals) => setValues.push(vals),
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(setValues[0]).toMatchObject({ message: null });
  });

  it("returns 403 when a co-tenant non-owner tries to reject", async () => {
    const db = resolveDb({
      row: OWNED_APPROVAL,
      callerPrincipal: { id: "other-prn" },
      instance: OWNED_INSTANCE,
      ownership: null,
    });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the approval to reject does not exist", async () => {
    const db = resolveDb({ row: null, callerPrincipal: OWNER_PRINCIPAL });

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-1/approvals/apr-missing/reject",
        { method: "POST" },
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe("createInternalApprovalsRouter", () => {
  const TOKEN = "sidecar-secret";

  function buildInternalApp(db: ReturnType<typeof makeMockDb>) {
    const parent = new Hono();
    parent.route("/", createInternalApprovalsRouter(db, TOKEN));
    return parent;
  }

  function authed(init: RequestInit = {}): RequestInit {
    return {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` },
    };
  }

  it("rejects requests with a missing or wrong bearer token", async () => {
    const app = buildInternalApp(makeMockDb());
    const res = await app.fetch(
      new Request("http://localhost/approvals", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON on create", async () => {
    const app = buildInternalApp(makeMockDb());
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not json",
        }),
      ),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("Invalid JSON");
  });

  it("returns 400 naming the missing required fields", async () => {
    const app = buildInternalApp(makeMockDb());
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: "tenant-1" }),
        }),
      ),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("agentId");
  });

  it("returns 400 when context is a primitive rather than an object", async () => {
    const app = buildInternalApp(makeMockDb());
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "tenant-1",
            agentId: "agt-1",
            principalId: "prn-1",
            action: "a",
            resource: "r",
            context: "not-an-object",
          }),
        }),
      ),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("context");
  });

  it("creates an approval and returns 201", async () => {
    const db = makeMockDb();
    const insertValues: Record<string, unknown>[] = [];
    const createdRow = {
      id: "apr-new",
      tenantId: "tenant-1",
      principalId: "prn-1",
      agentId: "agt-1",
      sessionId: null,
      resource: "file:/x",
      action: "write",
      status: "pending",
      context: { foo: "bar" },
      message: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.insert = mock(() => ({
      values: mock((vals: Record<string, unknown>) => {
        insertValues.push(vals);
        return { returning: mock(() => Promise.resolve([createdRow])) };
      }),
    }));

    const app = buildInternalApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "tenant-1",
            agentId: "agt-1",
            principalId: "prn-1",
            action: "write",
            resource: "file:/x",
            context: { foo: "bar" },
          }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as ResBody;
    expect(json.id).toBe("apr-new");
    expect(json.context).toEqual({ foo: "bar" });
    expect(insertValues[0]).toMatchObject({
      tenantId: "tenant-1",
      agentId: "agt-1",
      principalId: "prn-1",
      action: "write",
      resource: "file:/x",
      context: { foo: "bar" },
    });
  });

  it("persists the sessionId when the create body includes one", async () => {
    const db = makeMockDb();
    const insertValues: Record<string, unknown>[] = [];
    db.insert = mock(() => ({
      values: mock((vals: Record<string, unknown>) => {
        insertValues.push(vals);
        return {
          returning: mock(() =>
            Promise.resolve([
              {
                id: "apr-new",
                tenantId: "tenant-1",
                principalId: "prn-1",
                agentId: "agt-1",
                sessionId: "sess-1",
                resource: "r",
                action: "a",
                status: "pending",
                context: null,
                message: null,
                resolvedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          ),
        };
      }),
    }));

    const app = buildInternalApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "tenant-1",
            agentId: "agt-1",
            principalId: "prn-1",
            action: "a",
            resource: "r",
            sessionId: "sess-1",
          }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as ResBody;
    expect(json.sessionId).toBe("sess-1");
    expect(insertValues[0]).toMatchObject({ sessionId: "sess-1" });
  });

  it("omits context when a non-object context is provided on create", async () => {
    const db = makeMockDb();
    const insertValues: Record<string, unknown>[] = [];
    db.insert = mock(() => ({
      values: mock((vals: Record<string, unknown>) => {
        insertValues.push(vals);
        return {
          returning: mock(() =>
            Promise.resolve([
              {
                id: "apr-new",
                tenantId: "tenant-1",
                principalId: "prn-1",
                agentId: "agt-1",
                sessionId: null,
                resource: "r",
                action: "a",
                status: "pending",
                context: null,
                message: null,
                resolvedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          ),
        };
      }),
    }));

    const app = buildInternalApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals",
        authed({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "tenant-1",
            agentId: "agt-1",
            principalId: "prn-1",
            action: "a",
            resource: "r",
          }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(insertValues[0]?.context).toBeUndefined();
  });

  it("GET /approvals/:id requires the tenantId query param", async () => {
    const app = buildInternalApp(makeMockDb());
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals/apr-1",
        authed({ method: "GET" }),
      ),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("tenantId");
  });

  it("GET /approvals/:id returns 404 when not found", async () => {
    const db = makeMockDb();
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({ limit: mock(() => Promise.resolve([])) })),
      })),
    }));
    const app = buildInternalApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals/apr-1?tenantId=tenant-1",
        authed({ method: "GET" }),
      ),
    );
    expect(res.status).toBe(404);
  });

  it("GET /approvals/:id returns the formatted approval when found", async () => {
    const db = makeMockDb();
    const row = {
      id: "apr-1",
      tenantId: "tenant-1",
      principalId: "prn-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      resource: "r",
      action: "a",
      status: "pending",
      context: null,
      message: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({ limit: mock(() => Promise.resolve([row])) })),
      })),
    }));
    const app = buildInternalApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/approvals/apr-1?tenantId=tenant-1",
        authed({ method: "GET" }),
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.id).toBe("apr-1");
    expect(json.sessionId).toBe("sess-1");
  });
});
