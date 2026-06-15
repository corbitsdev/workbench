import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({
    globalTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
  loadConfig: () => ({}),
}));

mock.module("../services/workflow-orchestration", () => ({
  getUserContext: mock(async () => ({
    tenantId: "tn-global",
    principalId: "prn-user",
  })),
}));

import { createGammaTemplatesRouter } from "./gamma-templates";

// biome-ignore lint/suspicious/noExplicitAny: structural mock
type MockDb = any;

function makeMockDb(overrides: Partial<MockDb> = {}): MockDb {
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
          const tx: MockDb = {
            insert: mock(() => ({
              values: mock(() => ({
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
              })),
            })),
          };
          tx.insert.mockImplementationOnce(() => ({
            values: mock(() => ({
              returning: mock(() =>
                Promise.resolve([
                  {
                    id: "tpl-1",
                    version: 1,
                    name: "Sales Deck",
                    config: {
                      gammaId: "g1",
                      systemPrompt: "Use this to build a sales deck.",
                    },
                    createdAt: new Date(),
                  },
                ]),
              ),
            })),
          }));
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
            systemPrompt: "Use this to build a sales deck.",
          }),
        }),
      );
      expect(res.status).toBe(201);
    });
  });

  describe("DELETE /gamma-templates/:id", () => {
    it("returns 404 when no rows deleted", async () => {
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

    it("returns 200 when a template is deleted", async () => {
      const db = makeMockDb({
        delete: mock(() => ({
          where: mock(() => ({
            returning: mock(() => Promise.resolve([{ id: "tpl-1" }])),
          })),
        })),
      });
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
