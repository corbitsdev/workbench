import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

const memberByUser: Record<
  string,
  { tenantId: string; principalId: string } | null
> = {
  "user-a": { tenantId: "tenant-root", principalId: "principal-a" },
  "user-b": { tenantId: "tenant-root", principalId: "principal-b" },
  "user-none": null,
};
mock.module("../lib/tenant-provisioning", () => ({
  resolveCallerMember: async (_db: unknown, userId: string) =>
    memberByUser[userId] ?? null,
}));

mock.module("../lib/member-identity", () => ({
  getIdentityAccounts: async () => [],
}));

mock.module("../lib/task-push-store", () => ({
  createDrizzleTaskPushStore: () => ({}),
}));

type StoreCall = { fn: string; args: Record<string, unknown> };
const storeCalls: StoreCall[] = [];
let listRows: unknown[] = [];
let listNextCursor: string | undefined;
let updateResult: unknown = null;
let ownedResult: unknown = { id: "task-a" };

function apiTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    tenantId: "tenant-root",
    ownerPrincipalId: "principal-a",
    createdByPrincipalId: "principal-a",
    title: "Follow up",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

mock.module("../lib/task-store", () => ({
  listOwnerTasks: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "list", args });
    return {
      items: listRows,
      ...(listNextCursor ? { nextCursor: listNextCursor } : {}),
    };
  },
  createOwnerTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "create", args });
    return apiTask({ title: args["title"] });
  },
  updateOwnerTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "update", args });
    return updateResult;
  },
  getOwnerTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "get", args });
    return ownedResult;
  },
  getVisibleTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "getVisible", args });
    return ownedResult;
  },
  bulkUpdateOwnerTaskStatus: async (
    _db: unknown,
    args: Record<string, unknown>,
  ) => {
    storeCalls.push({ fn: "bulk", args });
    const ids = args["ids"] as string[];
    if (!updateResult) return [];
    return ids;
  },
}));

// Tenant members the assignee-validation check may see, keyed by principal
// id. Populated per-test; empty by default (every assignee id is rejected).
let tenantMembers: Record<string, { tenantId: string; kind: string }> = {};

function makeDb(): HubDb {
  return {
    query: {
      principal: {
        findFirst: async ({ where }: { where: unknown }) => {
          const seen = new Set<unknown>();
          const walk = (value: unknown): string | undefined => {
            if (typeof value === "string" && tenantMembers[value]) return value;
            if (value === null || typeof value !== "object" || seen.has(value))
              return undefined;
            seen.add(value);
            for (const v of Object.values(value)) {
              const found = walk(v);
              if (found) return found;
            }
            return undefined;
          };
          const id = walk(where);
          return id ? { id, ...tenantMembers[id] } : undefined;
        },
      },
    },
  } as unknown as HubDb;
}

let pushOutcome: unknown = {
  status: "synced",
  externalId: "ext-1",
  deduped: false,
};
const pushCalls: Record<string, unknown>[] = [];
const stubPushService = {
  pushTask: async (request: Record<string, unknown>) => {
    pushCalls.push(request);
    return pushOutcome;
  },
};
const tasksReal = await import("@workbench/tasks");
mock.module("@workbench/tasks", () => ({
  ...tasksReal,
  TASK_ADAPTERS: { attio: { id: "attio", providerName: "attio" } },
}));

const { createMeTasksRouter } = await import("./me-tasks");

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    return next();
  });
  v1.route(
    "/",
    createMeTasksRouter(
      makeDb(),
      stubPushService as unknown as Parameters<typeof createMeTasksRouter>[1],
    ),
  );
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

function req(
  path: string,
  init: RequestInit & { user?: string } = {},
): Request {
  const { user, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("x-test-user-id", user ?? "user-a");
  if (rest.body) headers.set("Content-Type", "application/json");
  return new Request(`http://local/api/v1${path}`, { ...rest, headers });
}

const VALID_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("GET /me/tasks", () => {
  it("scopes the list to the caller's principal", async () => {
    storeCalls.length = 0;
    listRows = [apiTask()];
    listNextCursor = undefined;
    const res = await mountApp().fetch(req("/me/tasks", { user: "user-a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [apiTask()] });
    expect(storeCalls[0]?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
    });
  });

  it("returns an empty page for a caller with no membership", async () => {
    const res = await mountApp().fetch(req("/me/tasks", { user: "user-none" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("passes a valid limit through and rejects a malformed one", async () => {
    storeCalls.length = 0;
    listRows = [];
    const ok = await mountApp().fetch(
      req("/me/tasks?limit=5", { user: "user-a" }),
    );
    expect(ok.status).toBe(200);
    expect(storeCalls[0]?.args).toMatchObject({ limit: 5 });

    const bad = await mountApp().fetch(
      req("/me/tasks?limit=nope", { user: "user-a" }),
    );
    expect(bad.status).toBe(400);
  });

  it("400s on a malformed cursor without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/tasks?cursor=not-a-valid-cursor", { user: "user-a" }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "list")).toBe(false);
  });

  it("surfaces nextCursor only when the store reports another page", async () => {
    listRows = [apiTask()];
    listNextCursor = "opaque-next";
    const res = await mountApp().fetch(req("/me/tasks", { user: "user-a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [apiTask()],
      nextCursor: "opaque-next",
    });
    listNextCursor = undefined;
  });
});

describe("GET /me/tasks/:id", () => {
  it("400s on a non-uuid id", async () => {
    const res = await mountApp().fetch(
      req("/me/tasks/not-a-uuid", { user: "user-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns the caller's task by id", async () => {
    storeCalls.length = 0;
    ownedResult = apiTask({ id: VALID_ID, status: "open" });
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, { user: "user-a" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(apiTask({ id: VALID_ID, status: "open" }));
    const get = storeCalls.find((c) => c.fn === "getVisible");
    expect(get?.args).toMatchObject({
      tenantId: "tenant-root",
      principalId: "principal-a",
      id: VALID_ID,
    });
  });

  it("404s when the caller does not own the task", async () => {
    ownedResult = null;
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, { user: "user-a" }),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the caller has no membership", async () => {
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, { user: "user-none" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /me/tasks", () => {
  it("creates a task owned by the caller with source=user", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/tasks", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ title: "Call Acme", body: "pricing" }),
      }),
    );
    expect(res.status).toBe(201);
    const create = storeCalls.find((c) => c.fn === "create");
    expect(create?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      createdByPrincipalId: "principal-a",
      title: "Call Acme",
      source: "user",
      body: "pricing",
    });
  });

  it("rejects an empty title without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/tasks", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ title: "" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "create")).toBe(false);
  });

  it("409s when the caller has no membership", async () => {
    const res = await mountApp().fetch(
      req("/me/tasks", {
        method: "POST",
        user: "user-none",
        body: JSON.stringify({ title: "x" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /me/tasks/:id", () => {
  it("400s on a non-uuid id", async () => {
    const res = await mountApp().fetch(
      req("/me/tasks/not-a-uuid", {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ status: "done" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400s on an empty patch", async () => {
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("updates the caller's task and returns it", async () => {
    storeCalls.length = 0;
    updateResult = apiTask({ status: "done" });
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ status: "done" }),
      }),
    );
    expect(res.status).toBe(200);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      id: VALID_ID,
      status: "done",
    });
  });

  it("assigns to a valid tenant member and passes assigneePrincipalId through", async () => {
    storeCalls.length = 0;
    tenantMembers = {
      "principal-c": { tenantId: "tenant-root", kind: "user" },
    };
    updateResult = apiTask({ assigneePrincipalId: "principal-c" });
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ assigneePrincipalId: "principal-c" }),
      }),
    );
    expect(res.status).toBe(200);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args).toMatchObject({
      assigneePrincipalId: "principal-c",
    });
  });

  it("clears the assignee with assigneePrincipalId: null, no membership check", async () => {
    storeCalls.length = 0;
    tenantMembers = {};
    updateResult = apiTask({});
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ assigneePrincipalId: null }),
      }),
    );
    expect(res.status).toBe(200);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args).toMatchObject({ assigneePrincipalId: null });
  });

  it("400s when the assignee is not a member of the caller's tenant", async () => {
    storeCalls.length = 0;
    tenantMembers = {};
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ assigneePrincipalId: "principal-ghost" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "update")).toBe(false);
  });
});

describe("POST /me/tasks/bulk", () => {
  const idA = "123e4567-e89b-42d3-a456-426614174001";
  const idB = "123e4567-e89b-42d3-a456-426614174002";

  it("applies status to owned task ids", async () => {
    storeCalls.length = 0;
    updateResult = apiTask({ status: "done" });
    const res = await mountApp().fetch(
      req("/me/tasks/bulk", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ ids: [idA, idB], status: "done" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2, ids: [idA, idB] });
    const bulk = storeCalls.find((c) => c.fn === "bulk");
    expect(bulk?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      status: "done",
      ids: [idA, idB],
    });
  });

  it("400s when ids exceed the bulk cap", async () => {
    const ids = Array.from({ length: 51 }, (_, i) =>
      `123e4567-e89b-42d3-a456-${String(i).padStart(12, "0")}`,
    );
    const res = await mountApp().fetch(
      req("/me/tasks/bulk", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ ids, status: "done" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("409s when the caller has no membership", async () => {
    const res = await mountApp().fetch(
      req("/me/tasks/bulk", {
        method: "POST",
        user: "user-none",
        body: JSON.stringify({ ids: [idA], status: "cancelled" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("cross-member isolation", () => {
  it("scopes member B's PATCH to B's principal, so A's task is untouchable", async () => {
    storeCalls.length = 0;
    updateResult = null;
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}`, {
        method: "PATCH",
        user: "user-b",
        body: JSON.stringify({ status: "cancelled" }),
      }),
    );
    expect(res.status).toBe(404);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args["ownerPrincipalId"]).toBe("principal-b");
    expect(update?.args["ownerPrincipalId"]).not.toBe("principal-a");
    expect(update?.args["id"]).toBe(VALID_ID);
  });
});

describe("POST /me/tasks/:id/push", () => {
  it("400s on an unknown adapter without pushing", async () => {
    pushCalls.length = 0;
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}/push`, {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ adapterId: "salesforce" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(pushCalls).toHaveLength(0);
  });

  it("404s when the caller does not own the task", async () => {
    ownedResult = null;
    pushCalls.length = 0;
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}/push`, {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ adapterId: "attio" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(pushCalls).toHaveLength(0);
  });

  it("pushes as the caller and returns the outcome (the call is the approval)", async () => {
    ownedResult = { id: VALID_ID };
    pushCalls.length = 0;
    pushOutcome = { status: "synced", externalId: "note_1", deduped: false };
    const res = await mountApp().fetch(
      req(`/me/tasks/${VALID_ID}/push`, {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ adapterId: "attio", operation: "create" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "synced",
      externalId: "note_1",
      deduped: false,
    });
    expect(pushCalls[0]).toEqual({
      taskId: VALID_ID,
      adapterId: "attio",
      operation: "create",
      actorPrincipalId: "principal-a",
    });
  });

  it("routes concurrent requests through the one injected push service instance", async () => {
    ownedResult = { id: VALID_ID };
    pushCalls.length = 0;
    pushOutcome = { status: "synced", externalId: "note_1", deduped: false };
    const app = mountApp();
    const [first, second] = await Promise.all([
      app.fetch(
        req(`/me/tasks/${VALID_ID}/push`, {
          method: "POST",
          user: "user-a",
          body: JSON.stringify({ adapterId: "attio", operation: "create" }),
        }),
      ),
      app.fetch(
        req(`/me/tasks/${VALID_ID}/push`, {
          method: "POST",
          user: "user-a",
          body: JSON.stringify({ adapterId: "attio", operation: "comment" }),
        }),
      ),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(pushCalls).toHaveLength(2);
    expect(pushCalls.map((c) => c["operation"]).sort()).toEqual([
      "comment",
      "create",
    ]);
  });
});
