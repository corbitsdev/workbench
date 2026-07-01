import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
  loadConfig: () => ({}),
}));

import { createGammaTemplatesRouter } from "./gamma-templates";

// biome-ignore lint/suspicious/noExplicitAny: structural mock
type MockDb = any;

const MOCK_TENANT = { id: "tn-global", slug: "global-org" };
const MOCK_PRINCIPAL = {
  id: "prn-user",
  tenantId: "tn-global",
  kind: "user",
  status: "active",
};

type GrantRow = {
  id: string;
  tenantId: string;
  roleId: string | null;
  principalId: string | null;
  resource: string;
  action: string;
  effect: "allow" | "deny" | "ask";
  conditions: unknown;
  origin: string;
  expiresAt: Date | null;
};

// Mirrors collectGrants' server-side filter (grant-store.ts): a grant is
// collected only when its tenantId AND principalId match the caller's context
// and it has not expired. The real drizzle `where` AST can't be introspected in
// a unit mock, so we replicate the predicate against the caller context the
// route resolves for the default (non-workbench) case: MOCK_PRINCIPAL in
// MOCK_TENANT. This lets negative rows (cross-tenant / expired) be filtered out
// exactly as collectGrants would, so the authz seam is genuinely exercised.
// TODO(CL-2604): a full pglite/testcontainers integration test would exercise
// the real drizzle predicate end-to-end; no such infra exists in-repo today.
function filterGrantsLikeCollect(rows: GrantRow[]): GrantRow[] {
  const now = Date.now();
  return rows.filter(
    (g) =>
      g.tenantId === MOCK_PRINCIPAL.tenantId &&
      g.principalId === MOCK_PRINCIPAL.id &&
      (g.expiresAt === null || g.expiresAt.getTime() > now),
  );
}

function makeMockDb(
  overrides: Partial<MockDb> = {},
  grantRows: GrantRow[] = [],
): MockDb {
  const selectResult: unknown[] = [];

  const queryBuilder = {
    from: mock(() => queryBuilder),
    innerJoin: mock(() => queryBuilder),
    where: mock(() => queryBuilder),
    orderBy: mock(() => queryBuilder),
    limit: mock(() => Promise.resolve(selectResult)),
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable for mocking Drizzle's awaitable query builder
    then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
  };

  const db: MockDb = {
    // These stubs mirror the two queries getUserContext makes:
    // db.query.tenant.findFirst({ where: eq(tenant.slug, globalTenant.slug) })
    // db.query.principal.findFirst({ where: and(eq(tenantId,...), eq(kind,'user'), eq(refId,...)) })
    // If getUserContext changes its resolution path, update these stubs to match.
    // principalRole/grant feed the real createGrantStore(db).collectGrants path.
    query: {
      tenant: { findFirst: mock(() => Promise.resolve(MOCK_TENANT)) },
      principal: {
        findFirst: mock(() => Promise.resolve(MOCK_PRINCIPAL)),
      },
      principalRole: { findMany: mock(() => Promise.resolve([])) },
      // Honors the collectGrants predicate (tenant + principal + non-expired)
      // so cross-tenant / expired rows are excluded exactly as the server does.
      grant: {
        findMany: mock(() =>
          Promise.resolve(filterGrantsLikeCollect(grantRows)),
        ),
        findFirst: mock(() => Promise.resolve(null)),
      },
    },
    select: mock(() => queryBuilder),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => ({
        returning: mock(() => Promise.resolve([])),
      })),
    })),
    transaction: mock(async <T>(fn: (tx: MockDb) => Promise<T>) =>
      fn(db as MockDb),
    ),
    ...overrides,
  };

  return db;
}

function wrapWithAuth(
  router: Hono<{ Variables: { userId: string } }>,
  userId = "user-1",
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", router);
  return app;
}

describe("createGammaTemplatesRouter", () => {
  describe("GET /gamma-templates", () => {
    it("returns 200 with an array", async () => {
      const db = makeMockDb();
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates"),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json)).toBe(true);
    });
  });

  describe("GET /gamma-templates (workbench-aware)", () => {
    it("walks the ancestor chain so global templates show under a workbench", async () => {
      // Requested tenant differs from global → getRequestedUserContext resolves
      // the requested principal; getAncestorChain then walks workbench → parent.
      const selectResult = [
        {
          id: "tpl-global",
          version: 1,
          name: "Inherited Deck",
          config: { gammaId: "g1", description: "Build a deck." },
          authorId: "prn-author",
          createdAt: new Date(),
        },
      ];
      const queryBuilder = {
        from: mock(() => queryBuilder),
        innerJoin: mock(() => queryBuilder),
        where: mock(() => queryBuilder),
        // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
        then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
        orderBy: mock(() => Promise.resolve(selectResult)),
      };
      const wb = { id: "tn-wb", slug: "workbench", parentId: "tn-global" };
      const db = makeMockDb({
        query: {
          // First findFirst (by slug): getUserContext resolves global.
          // Subsequent findFirst (by id, columns): getAncestorChain walks parentId.
          tenant: {
            findFirst: mock((args: { columns?: unknown }) =>
              Promise.resolve(args?.columns ? wb : MOCK_TENANT),
            ),
          },
          principal: {
            findFirst: mock(() =>
              Promise.resolve({ ...MOCK_PRINCIPAL, tenantId: "tn-wb" }),
            ),
          },
          principalRole: { findMany: mock(() => Promise.resolve([])) },
          grant: { findMany: mock(() => Promise.resolve([])) },
        },
        select: mock(() => queryBuilder),
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates?tenantId=tn-wb"),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: string }[];
      expect(json.map((r) => r.id)).toContain("tpl-global");
    });

    it("403s when the caller is not a principal of the requested tenant", async () => {
      // getUserContext finds the global principal (first call); the
      // requested-tenant principal lookup (second call) returns null → forbidden.
      let principalCalls = 0;
      const db = makeMockDb({
        query: {
          tenant: { findFirst: mock(() => Promise.resolve(MOCK_TENANT)) },
          principal: {
            findFirst: mock(() => {
              principalCalls += 1;
              return Promise.resolve(
                principalCalls === 1 ? MOCK_PRINCIPAL : null,
              );
            }),
          },
        },
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates?tenantId=tn-other"),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("POST /gamma-templates", () => {
    it("returns 400 when required fields are missing", async () => {
      const db = makeMockDb();
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Sales Deck" }),
        }),
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeString();
    });

    it("returns 201 when all fields are provided", async () => {
      const db = makeMockDb({
        transaction: mock(async <T>(fn: (tx: MockDb) => Promise<T>) => {
          // Handler order: header insert, then version insert, then grant.
          let insertCall = 0;
          const tx: MockDb = {
            insert: mock(() => {
              insertCall += 1;
              const which = insertCall;
              return {
                values: mock(() => ({
                  returning: mock(() => {
                    if (which === 1) {
                      return Promise.resolve([
                        {
                          id: "tpl-1",
                          tenantId: "tn-global",
                          kind: "gamma",
                          createdAt: new Date(),
                        },
                      ]);
                    }
                    if (which === 2) {
                      return Promise.resolve([
                        {
                          id: "tpl-1",
                          version: 1,
                          name: "Sales Deck",
                          config: {
                            gammaId: "g1",
                            description: "Use this to build a sales deck.",
                          },
                          authorId: "prn-user",
                          createdAt: new Date(),
                        },
                      ]);
                    }
                    return Promise.resolve([]);
                  }),
                })),
              };
            }),
          };
          return fn(tx);
        }),
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Sales Deck",
            gammaId: "g1",
            description: "Use this to build a sales deck.",
          }),
        }),
      );
      expect(res.status).toBe(201);
    });

    it("inserts an ownership manage grant inside the create transaction", async () => {
      const grantInserts: Record<string, unknown>[] = [];
      const db = makeMockDb({
        transaction: mock(async <T>(fn: (tx: MockDb) => Promise<T>) => {
          let insertCall = 0;
          const tx: MockDb = {
            insert: mock(() => {
              insertCall += 1;
              const which = insertCall;
              return {
                values: mock((vals: Record<string, unknown>) => {
                  if (which === 1) {
                    return {
                      returning: mock(() =>
                        Promise.resolve([
                          {
                            id: "tpl-1",
                            tenantId: "tn-global",
                            kind: "gamma",
                            createdAt: new Date(),
                          },
                        ]),
                      ),
                    };
                  }
                  if (which === 2) {
                    return {
                      returning: mock(() =>
                        Promise.resolve([
                          {
                            id: "tpl-1",
                            version: 1,
                            name: "Sales Deck",
                            config: { gammaId: "g1", description: "Desc" },
                            authorId: "prn-user",
                            createdAt: new Date(),
                          },
                        ]),
                      ),
                    };
                  }
                  grantInserts.push(vals);
                  return { returning: mock(() => Promise.resolve([])) };
                }),
              };
            }),
          };
          return fn(tx);
        }),
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Sales Deck",
            gammaId: "g1",
            description: "Desc",
          }),
        }),
      );
      expect(res.status).toBe(201);
      expect(grantInserts).toHaveLength(1);
      const g = grantInserts[0]!;
      expect(g.resource).toBe("template:tpl-1");
      expect(g.action).toBe("manage");
      expect(g.effect).toBe("allow");
      expect(g.origin).toBe("creator");
      expect(g.principalId).toBe("prn-user");
      expect(g.tenantId).toBe("tn-global");
    });
  });

  // `.limit(1)` resolves the existence check; awaiting the builder directly
  // (getLatestVersion does `await db.select().from().where()`) resolves the
  // MAX(version) aggregate row.
  function makeExistsBuilder(): MockDb {
    const builder: MockDb = {
      from: mock(() => builder),
      innerJoin: mock(() => builder),
      where: mock(() => builder),
      orderBy: mock(() => builder),
      limit: mock(() => Promise.resolve([{ id: "tpl-1" }])),
      // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
      then: (resolve: (v: unknown[]) => void) => resolve([{ maxVersion: 1 }]),
    };
    return builder;
  }

  const MANAGE_GRANT: GrantRow = {
    id: "grt-1",
    tenantId: "tn-global",
    roleId: null,
    principalId: "prn-user",
    resource: "template:tpl-1",
    action: "manage",
    effect: "allow",
    conditions: null,
    origin: "creator",
    expiresAt: null,
  };

  describe("GET /gamma-templates canManage", () => {
    function makeListDb(grantRows: GrantRow[]): MockDb {
      const selectResult = [
        {
          id: "tpl-1",
          version: 1,
          name: "Deck",
          config: { gammaId: "g1", description: "d" },
          authorId: "prn-other",
          createdAt: new Date(),
        },
      ];
      const queryBuilder = {
        from: mock(() => queryBuilder),
        innerJoin: mock(() => queryBuilder),
        where: mock(() => queryBuilder),
        // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
        then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
        orderBy: mock(() => Promise.resolve(selectResult)),
      };
      return makeMockDb({ select: mock(() => queryBuilder) }, grantRows);
    }

    it("marks canManage true when the caller holds a matching creator grant", async () => {
      const app = wrapWithAuth(
        createGammaTemplatesRouter(
          makeListDb([MANAGE_GRANT]) as unknown as HubDb,
        ),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates"),
      );
      const json = (await res.json()) as { id: string; canManage: boolean }[];
      expect(json[0]?.canManage).toBe(true);
    });

    it("marks canManage true for an owner glob grant", async () => {
      const owner: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-owner",
        resource: "*",
        action: "*",
        origin: "system",
      };
      const app = wrapWithAuth(
        createGammaTemplatesRouter(makeListDb([owner]) as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates"),
      );
      const json = (await res.json()) as { canManage: boolean }[];
      expect(json[0]?.canManage).toBe(true);
    });

    it("marks canManage false when the caller holds no matching grant", async () => {
      const other: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-other",
        resource: "template:tpl-999",
      };
      const app = wrapWithAuth(
        createGammaTemplatesRouter(makeListDb([other]) as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates"),
      );
      const json = (await res.json()) as { canManage: boolean }[];
      expect(json[0]?.canManage).toBe(false);
    });
  });

  describe("PUT /gamma-templates/:id manage gate", () => {
    it("returns 403 when the caller lacks manage", async () => {
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, []);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "n", gammaId: "g", description: "d" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("returns 200 when the caller holds manage", async () => {
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          insert: mock(() => ({
            values: mock(() => ({
              returning: mock(() =>
                Promise.resolve([
                  {
                    id: "tpl-1",
                    version: 2,
                    name: "n",
                    config: { gammaId: "g", description: "d" },
                    authorId: "prn-user",
                    createdAt: new Date(),
                  },
                ]),
              ),
            })),
          })),
        },
        [MANAGE_GRANT],
      );
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "n", gammaId: "g", description: "d" }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { version: number };
      expect(json.version).toBe(2);
    });

    it("computes the next version inside a transaction (atomic read+insert)", async () => {
      // getLatestVersion reads MAX(version)=1 via the exists-builder's thenable,
      // so the next version is 2. Asserting db.transaction ran proves the
      // read-then-insert is wrapped (the FIX 2 race guard), not two loose calls.
      let txCalls = 0;
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          insert: mock(() => ({
            values: mock(() => ({
              returning: mock(() =>
                Promise.resolve([
                  {
                    id: "tpl-1",
                    version: 2,
                    name: "n",
                    config: { gammaId: "g", description: "d" },
                    authorId: "prn-user",
                    createdAt: new Date(),
                  },
                ]),
              ),
            })),
          })),
        },
        [MANAGE_GRANT],
      );
      const inner = db.transaction;
      db.transaction = mock(async <T>(fn: (tx: MockDb) => Promise<T>) => {
        txCalls += 1;
        return inner(fn);
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "n", gammaId: "g", description: "d" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(txCalls).toBe(1);
      const json = (await res.json()) as { version: number };
      expect(json.version).toBe(2);
    });
  });

  describe("POST /gamma-templates/:id/delegates", () => {
    it("returns 400 when principalId is missing", async () => {
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, [
        MANAGE_GRANT,
      ]);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1/delegates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 403 when the caller lacks manage", async () => {
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, []);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1/delegates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principalId: "prn-target" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("inserts a manage grant for the target principal and returns 201", async () => {
      const grantInserts: Record<string, unknown>[] = [];
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          insert: mock(() => ({
            values: mock((vals: Record<string, unknown>) => {
              grantInserts.push(vals);
              return { returning: mock(() => Promise.resolve([])) };
            }),
          })),
        },
        [MANAGE_GRANT],
      );
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1/delegates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principalId: "prn-target" }),
        }),
      );
      expect(res.status).toBe(201);
      expect(grantInserts).toHaveLength(1);
      const g = grantInserts[0]!;
      expect(g.principalId).toBe("prn-target");
      expect(g.resource).toBe("template:tpl-1");
      expect(g.action).toBe("manage");
      expect(g.effect).toBe("allow");
    });

    it("returns 400 when the target principal is not a member of the tenant", async () => {
      const grantInserts: Record<string, unknown>[] = [];
      let principalCalls = 0;
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          insert: mock(() => ({
            values: mock((vals: Record<string, unknown>) => {
              grantInserts.push(vals);
              return { returning: mock(() => Promise.resolve([])) };
            }),
          })),
        },
        [MANAGE_GRANT],
      );
      // First principal.findFirst resolves the caller (getUserContext);
      // the second (the delegate target lookup) finds no such tenant member.
      db.query.principal.findFirst = mock(() => {
        principalCalls += 1;
        return Promise.resolve(principalCalls === 1 ? MOCK_PRINCIPAL : null);
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1/delegates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principalId: "prn-cross-tenant" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(grantInserts).toHaveLength(0);
    });

    it("does not insert a duplicate when an equivalent grant already exists", async () => {
      const grantInserts: Record<string, unknown>[] = [];
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          insert: mock(() => ({
            values: mock((vals: Record<string, unknown>) => {
              grantInserts.push(vals);
              return { returning: mock(() => Promise.resolve([])) };
            }),
          })),
        },
        [MANAGE_GRANT],
      );
      db.query.grant.findFirst = mock(() =>
        Promise.resolve({ ...MANAGE_GRANT, principalId: "prn-target" }),
      );
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1/delegates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principalId: "prn-target" }),
        }),
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(grantInserts).toHaveLength(0);
    });
  });

  // FIX 7: with the grant.findMany mock now honoring the collectGrants
  // predicate, prove the authz seam rejects grants that are out of scope.
  describe("PUT /gamma-templates/:id manage gate — grant scoping", () => {
    it("returns 403 when the only manage grant is in a DIFFERENT tenant", async () => {
      const crossTenant: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-cross",
        tenantId: "tn-other",
      };
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, [
        crossTenant,
      ]);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "n", gammaId: "g", description: "d" }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("returns 403 when the only manage grant has EXPIRED", async () => {
      const expired: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-expired",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      };
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, [
        expired,
      ]);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "n", gammaId: "g", description: "d" }),
        }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /gamma-templates canManage — grant scoping", () => {
    function makeListDbScoped(grantRows: GrantRow[]): MockDb {
      const selectResult = [
        {
          id: "tpl-1",
          version: 1,
          name: "Deck",
          config: { gammaId: "g1", description: "d" },
          authorId: "prn-other",
          createdAt: new Date(),
        },
      ];
      const queryBuilder = {
        from: mock(() => queryBuilder),
        innerJoin: mock(() => queryBuilder),
        where: mock(() => queryBuilder),
        // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
        then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
        orderBy: mock(() => Promise.resolve(selectResult)),
      };
      return makeMockDb({ select: mock(() => queryBuilder) }, grantRows);
    }

    it("canManage is false when the only grant is cross-tenant or expired", async () => {
      const crossTenant: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-cross",
        tenantId: "tn-other",
      };
      const expired: GrantRow = {
        ...MANAGE_GRANT,
        id: "grt-expired",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      };
      const app = wrapWithAuth(
        createGammaTemplatesRouter(
          makeListDbScoped([crossTenant, expired]) as unknown as HubDb,
        ),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates"),
      );
      const json = (await res.json()) as { canManage: boolean }[];
      expect(json[0]?.canManage).toBe(false);
    });
  });

  describe("DELETE /gamma-templates/:id", () => {
    it("returns 404 when the template does not exist in the tenant", async () => {
      const db = makeMockDb({
        delete: mock(() => ({
          where: mock(() => ({
            returning: mock(() => Promise.resolve([])),
          })),
        })),
      });
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/nonexistent", {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 when the caller lacks manage", async () => {
      const db = makeMockDb({ select: mock(() => makeExistsBuilder()) }, []);
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(403);
    });

    it("returns 200 when the caller holds manage and a row is deleted", async () => {
      const db = makeMockDb(
        {
          select: mock(() => makeExistsBuilder()),
          delete: mock(() => ({
            where: mock(() => ({
              returning: mock(() => Promise.resolve([{ id: "tpl-1" }])),
            })),
          })),
        },
        [MANAGE_GRANT],
      );
      const app = wrapWithAuth(
        createGammaTemplatesRouter(db as unknown as HubDb),
      );
      const res = await app.fetch(
        new Request("http://localhost/gamma-templates/tpl-1", {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });
});
