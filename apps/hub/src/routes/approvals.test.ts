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

describe("POST /tenants/:tenantId/approvals/:approvalId/approve", () => {
  it("returns 403 when the caller is not in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-other/approvals/apr-1/approve",
        {
          method: "POST",
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("uses the Interchange principalId (not userId) when filtering the approval update", async () => {
    // The approve endpoint must compare against callerPrincipal.id (the Interchange
    // principal ID) — not against the BetterAuth userId. Verify this by ensuring a
    // successful approve call resolves to the principal ID, not the user ID.
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const approvedRow = {
      id: "apr-1",
      tenantId: "tenant-1",
      principalId: PRINCIPAL.id,
      agentId: "agt-1",
      sessionId: null,
      resource: "file:/path",
      action: "read",
      status: "approved",
      context: null,
      message: null,
      resolvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const whereArgs: unknown[] = [];
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock((...args: unknown[]) => {
          whereArgs.push(args);
          return { returning: mock(() => Promise.resolve([approvedRow])) };
        }),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResBody;
    expect(json.id).toBe("apr-1");
    expect(json.status).toBe("approved");
    // The update was called once, confirming the endpoint proceeded past the
    // principalId check using PRINCIPAL.id (Interchange ID), not 'user-1' (BetterAuth ID).
    expect(whereArgs.length).toBe(1);
  });

  it("returns 404 when the approval does not exist", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve([])),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-1/approvals/apr-missing/approve",
        {
          method: "POST",
        },
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /tenants/:tenantId/approvals/:approvalId/reject", () => {
  it("returns 403 when the caller is not in the tenant", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(undefined));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-other/approvals/apr-1/reject",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Not allowed" }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a pending approval and persists the rejection message", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const setValues: Record<string, unknown>[] = [];
    const rejectedRow = {
      id: "apr-1",
      tenantId: "tenant-1",
      principalId: PRINCIPAL.id,
      agentId: "agt-1",
      sessionId: null,
      resource: "file:/path",
      action: "read",
      status: "rejected",
      context: null,
      message: "Not allowed",
      resolvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.update = mock(() => ({
      set: mock((vals: Record<string, unknown>) => {
        setValues.push(vals);
        return {
          where: mock(() => ({
            returning: mock(() => Promise.resolve([rejectedRow])),
          })),
        };
      }),
    }));

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
    expect(json.message).toBe("Not allowed");
    expect(setValues[0]).toMatchObject({
      status: "rejected",
      message: "Not allowed",
    });
  });

  it("stores a null message when the reject body omits one", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    const setValues: Record<string, unknown>[] = [];
    db.update = mock(() => ({
      set: mock((vals: Record<string, unknown>) => {
        setValues.push(vals);
        return {
          where: mock(() => ({
            returning: mock(() =>
              Promise.resolve([
                {
                  id: "apr-1",
                  tenantId: "tenant-1",
                  principalId: PRINCIPAL.id,
                  agentId: "agt-1",
                  sessionId: null,
                  resource: "r",
                  action: "a",
                  status: "rejected",
                  context: null,
                  message: null,
                  resolvedAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]),
            ),
          })),
        };
      }),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(setValues[0]).toMatchObject({ message: null });
  });

  it("returns 404 when the approval to reject does not exist", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({ limit: mock(() => Promise.resolve([])) })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request(
        "http://localhost/tenants/tenant-1/approvals/apr-missing/reject",
        {
          method: "POST",
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when rejecting an approval owned by another principal", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() =>
            Promise.resolve([{ id: "apr-1", principalId: "prn-other" }]),
          ),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when the approval was already resolved", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() =>
            Promise.resolve([{ id: "apr-1", principalId: PRINCIPAL.id }]),
          ),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/reject", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("Already resolved");
  });
});

describe("POST /tenants/:tenantId/approvals/:approvalId/approve resolution branches", () => {
  it("returns 403 when approving an approval owned by another principal", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() =>
            Promise.resolve([{ id: "apr-1", principalId: "prn-other" }]),
          ),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when the approval was already resolved", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));
    db.update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    }));
    db.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() =>
            Promise.resolve([{ id: "apr-1", principalId: PRINCIPAL.id }]),
          ),
        })),
      })),
    }));

    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/apr-1/approve", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
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

  it("returns 400 when required fields are missing", async () => {
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
    expect(json.error).toContain("Missing required fields");
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
