import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

// Caller identity: userId -> membership. user-none has no membership.
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

const intxDbReal = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDbReal,
  getAncestorChain: async () => ["tenant-root"],
}));

let runnableKinds = [{ kind: "heartbeat" }, { kind: "deck" }];
mock.module("../lib/workflow-run-gate", () => ({
  isRunnableKind: async (_db: unknown, _tenantId: string, kind: string) =>
    runnableKinds.some((k) => k.kind === kind),
}));

// Store spy. Each call is captured so a test asserts the owner principal the
// route scoped the operation to — the cross-member isolation guarantee.
type StoreCall = { fn: string; args: Record<string, unknown> };
const storeCalls: StoreCall[] = [];
type OwnerRow = {
  id: string;
  workflowKind: string;
  hourUtc: number;
  enabled: boolean;
  triggerPayload: Record<string, unknown>;
  createdAt: Date;
};
let ownerRows: OwnerRow[] = [];
let updateResult: OwnerRow | null = null;
let deleteResult = false;
mock.module("../lib/scheduled-triggers", () => ({
  toApiSchedule: (r: OwnerRow) => ({
    id: r.id,
    workflowKind: r.workflowKind,
    hourUtc: r.hourUtc,
    enabled: r.enabled,
    triggerPayload: r.triggerPayload,
    createdAt: r.createdAt.toISOString(),
  }),
  listOwnerSchedules: async (
    _db: unknown,
    tenantId: string,
    ownerPrincipalId: string,
    opts?: Record<string, unknown>,
  ) => {
    storeCalls.push({
      fn: "list",
      args: { tenantId, ownerPrincipalId, ...(opts ?? {}) },
    });
    return { items: ownerRows };
  },
  createOwnerSchedule: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "create", args });
    return {
      id: "sch-new",
      workflowKind: args["kind"],
      hourUtc: args["hourUtc"],
      enabled: true,
      triggerPayload: args["payload"],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  },
  updateOwnerSchedule: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "update", args });
    return updateResult;
  },
  deleteOwnerSchedule: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "delete", args });
    return deleteResult;
  },
}));

const { createMeSchedulesRouter } = await import("./me-schedules");

// Mirrors the index.ts wiring: the caller's member principal resolves to their
// own user mail identity — never to anything the client supplied.
const identityByPrincipal: Record<
  string,
  { userAddress: string; userRefId: string }
> = {
  "principal-a": {
    userAddress: "usr_user-a@workbench.example",
    userRefId: "user-a",
  },
  "principal-b": {
    userAddress: "usr_user-b@workbench.example",
    userRefId: "user-b",
  },
};

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    return next();
  });
  v1.route(
    "/",
    createMeSchedulesRouter({} as unknown as HubDb, async (principalId) => {
      const identity = identityByPrincipal[principalId];
      if (!identity) throw new Error(`principal not found: ${principalId}`);
      return identity;
    }),
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

const SCHED_ID = "11111111-1111-4111-8111-111111111111";
const SCHED_ID_A = "22222222-2222-4222-8222-222222222222";

describe("GET /me/schedules", () => {
  it("returns the caller's own schedules, scoped to their principal", async () => {
    storeCalls.length = 0;
    ownerRows = [
      {
        id: "sch-1",
        workflowKind: "heartbeat",
        hourUtc: 13,
        enabled: true,
        triggerPayload: { reason: "scheduled-heartbeat" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const res = await mountApp().fetch(
      req("/me/schedules", { user: "user-a" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      items: [
        {
          id: "sch-1",
          workflowKind: "heartbeat",
          hourUtc: 13,
          enabled: true,
          triggerPayload: { reason: "scheduled-heartbeat" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(storeCalls[0]).toMatchObject({
      fn: "list",
      args: { tenantId: "tenant-root", ownerPrincipalId: "principal-a" },
    });
  });

  it("passes a valid limit through and rejects a malformed one", async () => {
    storeCalls.length = 0;
    ownerRows = [];
    const ok = await mountApp().fetch(
      req("/me/schedules?limit=5", { user: "user-a" }),
    );
    expect(ok.status).toBe(200);
    expect(storeCalls[0]?.args).toMatchObject({ limit: 5 });

    const bad = await mountApp().fetch(
      req("/me/schedules?limit=nope", { user: "user-a" }),
    );
    expect(bad.status).toBe(400);
  });

  it("400s on a malformed cursor without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/schedules?cursor=not-a-valid-cursor", { user: "user-a" }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "list")).toBe(false);
  });

  it("returns an empty page when the caller has no membership", async () => {
    ownerRows = [];
    const res = await mountApp().fetch(
      req("/me/schedules", { user: "user-none" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});

describe("POST /me/schedules", () => {
  it("creates a schedule scoped to the caller for a runnable kind", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ kind: "deck", hourUtc: 9, payload: { x: 1 } }),
      }),
    );
    expect(res.status).toBe(201);
    const create = storeCalls.find((c) => c.fn === "create");
    expect(create?.args).toEqual({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      kind: "deck",
      hourUtc: 9,
      payload: {
        x: 1,
        userAddress: "usr_user-a@workbench.example",
        userRefId: "user-a",
      },
    });
  });

  it("overrides client-supplied identity keys with the caller's own", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({
          kind: "heartbeat",
          hourUtc: 7,
          payload: {
            reason: "scheduled-heartbeat",
            userAddress: "usr_user-b@workbench.example",
            userRefId: "user-b",
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const create = storeCalls.find((c) => c.fn === "create");
    expect(create?.args["payload"]).toEqual({
      reason: "scheduled-heartbeat",
      userAddress: "usr_user-a@workbench.example",
      userRefId: "user-a",
    });
  });

  it("rejects a payload larger than 8KB without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({
          kind: "deck",
          hourUtc: 9,
          payload: { blob: "x".repeat(9000) },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "create")).toBe(false);
  });

  it("rejects an out-of-range hour without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ kind: "deck", hourUtc: 25 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "create")).toBe(false);
  });

  it("rejects a kind not in the runnable catalog", async () => {
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ kind: "not-a-workflow", hourUtc: 9 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("409s when the caller has no membership", async () => {
    const res = await mountApp().fetch(
      req("/me/schedules", {
        method: "POST",
        user: "user-none",
        body: JSON.stringify({ kind: "deck", hourUtc: 9 }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /me/schedules/:id", () => {
  it("rejects a malformed (non-UUID) id with 400", async () => {
    const res = await mountApp().fetch(
      req("/me/schedules/not-a-uuid", {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty patch", async () => {
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("updates the caller's schedule and returns it", async () => {
    storeCalls.length = 0;
    updateResult = {
      id: SCHED_ID,
      workflowKind: "heartbeat",
      hourUtc: 7,
      enabled: false,
      triggerPayload: {},
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ enabled: false, hourUtc: 7 }),
      }),
    );
    expect(res.status).toBe(200);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args).toEqual({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      id: SCHED_ID,
      enabled: false,
      hourUtc: 7,
    });
  });

  it("404s when no schedule matches the caller (missing or another member's)", async () => {
    updateResult = null;
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID}`, {
        method: "PATCH",
        user: "user-a",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /me/schedules/:id", () => {
  it("rejects a malformed (non-UUID) id with 400", async () => {
    const res = await mountApp().fetch(
      req("/me/schedules/not-a-uuid", { method: "DELETE", user: "user-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("deletes the caller's schedule", async () => {
    deleteResult = true;
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID}`, { method: "DELETE", user: "user-a" }),
    );
    expect(res.status).toBe(204);
  });

  it("404s when the schedule is not the caller's", async () => {
    deleteResult = false;
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID}`, { method: "DELETE", user: "user-a" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("cross-member isolation", () => {
  it("scopes member B's PATCH to B's principal, so A's schedule is untouchable", async () => {
    storeCalls.length = 0;
    // The store, scoped by owner, finds no row of A owned by B -> null -> 404.
    updateResult = null;
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID_A}`, {
        method: "PATCH",
        user: "user-b",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(404);
    const update = storeCalls.find((c) => c.fn === "update");
    expect(update?.args["ownerPrincipalId"]).toBe("principal-b");
    expect(update?.args["ownerPrincipalId"]).not.toBe("principal-a");
    expect(update?.args["id"]).toBe(SCHED_ID_A);
  });

  it("scopes member B's DELETE to B's principal", async () => {
    storeCalls.length = 0;
    deleteResult = false;
    const res = await mountApp().fetch(
      req(`/me/schedules/${SCHED_ID_A}`, {
        method: "DELETE",
        user: "user-b",
      }),
    );
    expect(res.status).toBe(404);
    const del = storeCalls.find((c) => c.fn === "delete");
    expect(del?.args["ownerPrincipalId"]).toBe("principal-b");
  });
});
