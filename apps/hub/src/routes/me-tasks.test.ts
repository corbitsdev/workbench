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
    return listRows;
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
}));

let pushOutcome: unknown = {
  status: "synced",
  externalId: "ext-1",
  deduped: false,
};
const pushCalls: Record<string, unknown>[] = [];
const tasksReal = await import("@workbench/tasks");
mock.module("@workbench/tasks", () => ({
  ...tasksReal,
  TASK_ADAPTERS: { attio: { id: "attio", providerName: "attio" } },
  createTaskPushService: () => ({
    pushTask: async (request: Record<string, unknown>) => {
      pushCalls.push(request);
      return pushOutcome;
    },
  }),
}));

const { createMeTasksRouter } = await import("./me-tasks");

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    return next();
  });
  v1.route("/", createMeTasksRouter({} as unknown as HubDb));
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
    const res = await mountApp().fetch(req("/me/tasks", { user: "user-a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([apiTask()]);
    expect(storeCalls[0]?.args).toEqual({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
    });
  });

  it("returns empty for a caller with no membership", async () => {
    const res = await mountApp().fetch(req("/me/tasks", { user: "user-none" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
});
