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

type StoreCall = { fn: string; args: Record<string, unknown> };
const storeCalls: StoreCall[] = [];
type OwnerRow = {
  id: string;
  workflowKind: string;
  enabled: boolean;
  createdAt: Date;
  lastFiredAt: Date | null;
};
let ownerRows: OwnerRow[] = [];
let createdSecret = "unset-secret";
let deleteResult = false;
mock.module("../lib/webhook-triggers", () => ({
  toApiWebhookTrigger: (r: OwnerRow) => ({
    id: r.id,
    workflowKind: r.workflowKind,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    lastFiredAt: r.lastFiredAt ? r.lastFiredAt.toISOString() : null,
  }),
  listOwnerWebhookTriggers: async (
    _db: unknown,
    tenantId: string,
    ownerPrincipalId: string,
  ) => {
    storeCalls.push({ fn: "list", args: { tenantId, ownerPrincipalId } });
    return ownerRows;
  },
  createOwnerWebhookTrigger: async (
    _db: unknown,
    args: Record<string, unknown>,
  ) => {
    storeCalls.push({ fn: "create", args });
    return {
      row: {
        id: "trig-new",
        workflowKind: args["kind"],
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastFiredAt: null,
      },
      secret: createdSecret,
    };
  },
  deleteOwnerWebhookTrigger: async (
    _db: unknown,
    args: Record<string, unknown>,
  ) => {
    storeCalls.push({ fn: "delete", args });
    return deleteResult;
  },
}));

const { createMeWebhookTriggersRouter } = await import("./me-webhook-triggers");

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    return next();
  });
  v1.route("/", createMeWebhookTriggersRouter({} as unknown as HubDb));
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

describe("GET /me/webhook-triggers", () => {
  it("returns the caller's own triggers, scoped to their principal, without secrets", async () => {
    storeCalls.length = 0;
    ownerRows = [
      {
        id: "trig-1",
        workflowKind: "heartbeat",
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastFiredAt: null,
      },
    ];
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", { user: "user-a" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "trig-1",
        workflowKind: "heartbeat",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastFiredAt: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(storeCalls[0]).toEqual({
      fn: "list",
      args: { tenantId: "tenant-root", ownerPrincipalId: "principal-a" },
    });
  });

  it("returns an empty list when the caller has no membership", async () => {
    ownerRows = [];
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", { user: "user-none" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /me/webhook-triggers", () => {
  it("creates a trigger scoped to the caller for a runnable kind, returning the secret once", async () => {
    storeCalls.length = 0;
    createdSecret = "plaintext-secret-value";
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ kind: "deck" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      id: "trig-new",
      workflowKind: "deck",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastFiredAt: null,
      secret: "plaintext-secret-value",
    });
    const create = storeCalls.find((c) => c.fn === "create");
    expect(create?.args).toEqual({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-a",
      kind: "deck",
    });
  });

  it("rejects a kind not in the runnable catalog", async () => {
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({ kind: "not-a-workflow" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing kind", async () => {
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", {
        method: "POST",
        user: "user-a",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("409s when the caller has no membership", async () => {
    const res = await mountApp().fetch(
      req("/me/webhook-triggers", {
        method: "POST",
        user: "user-none",
        body: JSON.stringify({ kind: "deck" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /me/webhook-triggers/:id", () => {
  it("400s on a malformed trigger id without touching the store", async () => {
    storeCalls.length = 0;
    const res = await mountApp().fetch(
      req("/me/webhook-triggers/not-a-uuid", {
        method: "DELETE",
        user: "user-a",
      }),
    );
    expect(res.status).toBe(400);
    expect(storeCalls.some((c) => c.fn === "delete")).toBe(false);
  });

  it("deletes the caller's trigger", async () => {
    deleteResult = true;
    const res = await mountApp().fetch(
      req("/me/webhook-triggers/11111111-1111-1111-1111-111111111111", {
        method: "DELETE",
        user: "user-a",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("404s when the trigger is not the caller's", async () => {
    deleteResult = false;
    const res = await mountApp().fetch(
      req("/me/webhook-triggers/11111111-1111-1111-1111-111111111111", {
        method: "DELETE",
        user: "user-a",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("cross-member isolation", () => {
  it("scopes member B's DELETE to B's principal, so A's trigger is untouchable", async () => {
    storeCalls.length = 0;
    deleteResult = false;
    const res = await mountApp().fetch(
      req("/me/webhook-triggers/22222222-2222-2222-2222-222222222222", {
        method: "DELETE",
        user: "user-b",
      }),
    );
    expect(res.status).toBe(404);
    const del = storeCalls.find((c) => c.fn === "delete");
    expect(del?.args["ownerPrincipalId"]).toBe("principal-b");
    expect(del?.args["ownerPrincipalId"]).not.toBe("principal-a");
  });
});
