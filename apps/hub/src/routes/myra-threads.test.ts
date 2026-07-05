import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// biome-ignore lint/suspicious/noExplicitAny: structural mocks for service boundary
const listMyraThreads = mock<(...args: any[]) => Promise<any[]>>(() =>
  Promise.resolve([]),
);
const createMyraThread = mock<(...args: any[]) => Promise<any>>(() =>
  Promise.resolve({ created: true, thread: {} }),
);
// biome-ignore lint/suspicious/noExplicitAny: structural mocks for service boundary
const renameMyraThread = mock<(...args: any[]) => Promise<any>>(() =>
  Promise.resolve(null),
);
// biome-ignore lint/suspicious/noExplicitAny: structural mocks for service boundary
const deleteMyraThread = mock<(...args: any[]) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
// biome-ignore lint/suspicious/noExplicitAny: structural mocks for service boundary
const generateMyraThreadTitle = mock<(...args: any[]) => Promise<any>>(() =>
  Promise.resolve(null),
);
const resolveMyraThreadContext = mock(() =>
  Promise.resolve<{
    tenantId: string;
    tenantDomain: string;
    memberPrincipalId: string;
  } | null>({
    tenantId: "tn-global",
    tenantDomain: "myra.test",
    memberPrincipalId: "prn-member",
  }),
);

mock.module("../services/myra-threads", () => ({
  listMyraThreads,
  createMyraThread,
  renameMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  resolveMyraThreadContext,
}));

const { createMyraThreadsRouter } = await import("./myra-threads");

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
  // biome-ignore lint/suspicious/noExplicitAny: structural mocks for injected deps
  return createMyraThreadsRouter({} as any, {} as any) as unknown as Hono;
}

describe("Myra threads router", () => {
  beforeEach(() => {
    listMyraThreads.mockClear();
    createMyraThread.mockClear();
    renameMyraThread.mockClear();
    deleteMyraThread.mockClear();
    generateMyraThreadTitle.mockClear();
    resolveMyraThreadContext.mockClear();
    resolveMyraThreadContext.mockResolvedValue({
      tenantId: "tn-global",
      tenantDomain: "myra.test",
      memberPrincipalId: "prn-member",
    });
  });

  it("lists threads for the resolved member", async () => {
    listMyraThreads.mockResolvedValueOnce([
      {
        id: "map-1",
        instanceId: "inst-1",
        label: "Chat",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threads: { id: string; label: string }[];
    };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.label).toBe("Chat");
    expect(listMyraThreads).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
    });
  });

  it("returns 403 when the user is not a member of the tenant", async () => {
    resolveMyraThreadContext.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads");
    expect(res.status).toBe(403);
    expect(listMyraThreads).not.toHaveBeenCalled();
  });

  it("passes the path tenantId through to the service", async () => {
    listMyraThreads.mockResolvedValueOnce([]);
    const app = wrapWithAuth(buildRouter());
    await app.request("/tenants/tn-child/me/myra/threads");
    expect(resolveMyraThreadContext).toHaveBeenCalledWith(
      expect.anything(),
      "usr-1",
      "tn-child",
    );
  });

  it("creates a thread and returns 201 with the created thread", async () => {
    createMyraThread.mockResolvedValueOnce({
      created: true,
      thread: {
        id: "map-2",
        instanceId: "inst-2",
        label: "Pricing",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Pricing" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      thread: { label: string };
      created: boolean;
    };
    expect(body.thread.label).toBe("Pricing");
    // CL-2803: create is lazy — the router calls the service with (db, opts)
    // only, no session-launch deps, and returns 201 without launching.
    expect(createMyraThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        label: "Pricing",
      }),
    );
  });

  it("returns 403 on create when the user is not a member of the tenant", async () => {
    resolveMyraThreadContext.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(createMyraThread).not.toHaveBeenCalled();
  });

  it("renames a thread and returns 200 with the updated thread", async () => {
    renameMyraThread.mockResolvedValueOnce({
      id: "map-1",
      instanceId: "inst-1",
      label: "Renamed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: { label: string } };
    expect(body.thread.label).toBe("Renamed");
    expect(renameMyraThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: "map-1", label: "Renamed" }),
    );
  });

  it("returns 404 on rename when the thread is not found", async () => {
    renameMyraThread.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Whatever" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on rename when the label is empty", async () => {
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "   " }),
    });
    expect(res.status).toBe(400);
    expect(renameMyraThread).not.toHaveBeenCalled();
  });

  it("returns 403 on rename when the user is not a member of the tenant", async () => {
    resolveMyraThreadContext.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(res.status).toBe(403);
    expect(renameMyraThread).not.toHaveBeenCalled();
  });

  it("deletes a thread and returns 200", async () => {
    deleteMyraThread.mockResolvedValueOnce(true);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(deleteMyraThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ threadId: "map-1" }),
    );
  });

  it("returns 404 on delete when the thread is not found", async () => {
    deleteMyraThread.mockResolvedValueOnce(false);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-x", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("titles a thread and returns 200 with the titled thread", async () => {
    generateMyraThreadTitle.mockResolvedValueOnce({
      id: "map-1",
      instanceId: "inst-1",
      label: "Pricing Deep Dive",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const app = wrapWithAuth(buildRouter());
    const res = await app.request(
      "/tenants/tn-global/me/myra/threads/map-1/title",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstMessage: "How should we price the enterprise tier?",
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: { label: string } | null };
    expect(body.thread?.label).toBe("Pricing Deep Dive");
    expect(generateMyraThreadTitle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        threadId: "map-1",
        firstMessage: "How should we price the enterprise tier?",
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
      }),
    );
  });

  it("returns 200 with thread null when titling is a no-op", async () => {
    generateMyraThreadTitle.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request(
      "/tenants/tn-global/me/myra/threads/map-1/title",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstMessage: "Hi" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: unknown };
    expect(body.thread).toBeNull();
  });

  it("returns 400 on title when firstMessage is empty", async () => {
    const app = wrapWithAuth(buildRouter());
    const res = await app.request(
      "/tenants/tn-global/me/myra/threads/map-1/title",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstMessage: "" }),
      },
    );
    expect(res.status).toBe(400);
    expect(generateMyraThreadTitle).not.toHaveBeenCalled();
  });

  it("returns 403 on title when the user is not a member of the tenant", async () => {
    resolveMyraThreadContext.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request(
      "/tenants/tn-global/me/myra/threads/map-1/title",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstMessage: "Hello there" }),
      },
    );
    expect(res.status).toBe(403);
    expect(generateMyraThreadTitle).not.toHaveBeenCalled();
  });

  it("returns 403 on delete when the user is not a member of the tenant", async () => {
    resolveMyraThreadContext.mockResolvedValueOnce(null);
    const app = wrapWithAuth(buildRouter());
    const res = await app.request("/tenants/tn-global/me/myra/threads/map-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(deleteMyraThread).not.toHaveBeenCalled();
  });
});
