import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";
import type { WorkflowRunStarter } from "../services/workflow-run-starter";

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

const HEARTBEAT_KIND = "heartbeat";

let scheduleRowsByPrincipal: Record<
  string,
  {
    workflowKind: string;
    hourUtc: number;
    lastFiredDayUtc: number | null;
    triggerPayload: Record<string, unknown>;
  }[]
> = {
  "principal-a": [
    {
      workflowKind: HEARTBEAT_KIND,
      hourUtc: 13,
      lastFiredDayUtc: null,
      triggerPayload: { reason: "scheduled-heartbeat" },
    },
  ],
  "principal-b": [
    {
      workflowKind: HEARTBEAT_KIND,
      hourUtc: 9,
      lastFiredDayUtc: null,
      triggerPayload: { reason: "scheduled-heartbeat" },
    },
  ],
};

mock.module("../lib/scheduled-triggers", () => ({
  listOwnerSchedules: async (
    _db: unknown,
    _tenantId: string,
    ownerPrincipalId: string,
  ) => ({ items: scheduleRowsByPrincipal[ownerPrincipalId] ?? [] }),
}));

let preferencesByPrincipal: Record<string, Record<string, unknown>> = {
  "principal-a": {},
  "principal-b": {},
};
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async (
    _db: unknown,
    _tenantId: string,
    principalId: string,
  ) => preferencesByPrincipal[principalId] ?? {},
}));

const { createMeBriefRunRouter } = await import("./me-brief-run");

type StartRunCall = {
  kind: string;
  tenantId: string;
  input: Record<string, unknown>;
  creatorPrincipalId?: string;
  source?: string;
};
let startRunCalls: StartRunCall[] = [];
let startRunResult:
  | { ok: true; deploymentId: string }
  | {
      ok: false;
      reason: "not_found" | "delivery_failed" | "rate_limited";
      message: string;
    } = {
  ok: true,
  deploymentId: "dep-1",
};

const runStarter: WorkflowRunStarter = {
  startRun: async (args) => {
    startRunCalls.push(args);
    return startRunResult;
  },
};

function mountApp(
  now: () => number = () => Date.parse("2026-07-12T13:05:00.000Z"),
) {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    return next();
  });
  v1.route(
    "/",
    createMeBriefRunRouter({
      db: {} as unknown as HubDb,
      runStarter,
      heartbeatKind: HEARTBEAT_KIND,
      resolveUserIdentity: async (memberPrincipalId: string) => ({
        userAddress: `usr_${memberPrincipalId}@tenant.example`,
        userRefId: memberPrincipalId,
      }),
      now,
    }),
  );
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

function req(path: string, user = "user-a"): Request {
  const headers = new Headers();
  headers.set("x-test-user-id", user);
  return new Request(`http://local/api/v1${path}`, {
    method: "POST",
    headers,
  });
}

describe("POST /me/brief-run", () => {
  it("starts a run for the caller's heartbeat kind, source manual, enriched payload", async () => {
    startRunCalls = [];
    startRunResult = { ok: true, deploymentId: "dep-1" };
    preferencesByPrincipal["principal-a"] = {
      "brief-source:granola": true,
    };
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-a"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "started",
      deploymentId: "dep-1",
    });
    expect(startRunCalls).toHaveLength(1);
    const call = startRunCalls[0];
    expect(call?.kind).toBe(HEARTBEAT_KIND);
    expect(call?.tenantId).toBe("tenant-root");
    expect(call?.creatorPrincipalId).toBe("principal-a");
    expect(call?.source).toBe("manual");
    expect(call?.input.reason).toBe("scheduled-heartbeat");
    expect(typeof call?.input.createdAfter).toBe("string");
  });

  it("404s when the caller has no membership", async () => {
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-none"));
    expect(res.status).toBe(404);
  });

  it("rejects a second manual run from the same member within the window", async () => {
    startRunCalls = [];
    startRunResult = { ok: true, deploymentId: "dep-1" };
    const app = mountApp();
    const first = await app.fetch(req("/me/brief-run", "user-a"));
    expect(first.status).toBe(200);
    const second = await app.fetch(req("/me/brief-run", "user-a"));
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      error: "You just ran a brief — try again in a few minutes",
    });
    expect(startRunCalls).toHaveLength(1);
  });

  it("does not rate-limit a different member", async () => {
    startRunCalls = [];
    startRunResult = { ok: true, deploymentId: "dep-2" };
    const app = mountApp();
    const a = await app.fetch(req("/me/brief-run", "user-a"));
    expect(a.status).toBe(200);
    const b = await app.fetch(req("/me/brief-run", "user-b"));
    expect(b.status).toBe(200);
    expect(startRunCalls).toHaveLength(2);
  });

  it("surfaces a generic message, not the internal reason, when the run fails to start", async () => {
    startRunCalls = [];
    startRunResult = {
      ok: false,
      reason: "delivery_failed",
      message: "sidecar unroutable: internal detail",
    };
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-a"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "The brief could not be started" });
    expect(JSON.stringify(body)).not.toContain("sidecar unroutable");
  });

  it("starts a run with a fallback payload when no schedule row exists", async () => {
    startRunCalls = [];
    startRunResult = { ok: true, deploymentId: "dep-2" };
    scheduleRowsByPrincipal["principal-a"] = [];
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-a"));
    expect(res.status).toBe(200);
    const call = startRunCalls[0];
    expect(call?.input.userAddress).toBe("usr_principal-a@tenant.example");
    expect(call?.input.enabledSources).toBeDefined();
    expect(call?.input.createdAfter).toBeDefined();
    scheduleRowsByPrincipal["principal-a"] = [
      {
        workflowKind: HEARTBEAT_KIND,
        hourUtc: 13,
        lastFiredDayUtc: null,
        triggerPayload: { reason: "scheduled-heartbeat" },
      },
    ];
  });

  it("does not consume the rate window when the run fails to start", async () => {
    startRunCalls = [];
    startRunResult = {
      ok: false,
      reason: "delivery_failed",
      message: "sidecar exploded",
    };
    const app = mountApp();
    const first = await app.fetch(req("/me/brief-run", "user-a"));
    expect(first.status).toBe(502);
    startRunResult = { ok: true, deploymentId: "dep-3" };
    const second = await app.fetch(req("/me/brief-run", "user-a"));
    expect(second.status).toBe(200);
  });
});
