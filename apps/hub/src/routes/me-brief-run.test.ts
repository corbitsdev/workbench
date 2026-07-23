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
    intervalMinutes: number;
    anchorMinuteUtc: number;
    triggerPayload: Record<string, unknown>;
  }[]
> = {
  "principal-a": [
    {
      workflowKind: HEARTBEAT_KIND,
      intervalMinutes: 1440,
      anchorMinuteUtc: 13 * 60,
      triggerPayload: { reason: "scheduled-heartbeat" },
    },
  ],
  "principal-b": [
    {
      workflowKind: HEARTBEAT_KIND,
      intervalMinutes: 1440,
      anchorMinuteUtc: 9 * 60,
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
  | { ok: true; deploymentId: string; runId: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "provision_failed"
        | "attach_failed"
        | "delivery_failed"
        | "rate_limited";
      message: string;
    } = {
  ok: true,
  deploymentId: "dep-1",
  runId: "run-1",
};
// When set, the fake starter throws instead of returning — simulates a
// failure inside startRun's own trigger-payload enrichment (e.g. the
// registry's resolveUserIdentity call failing), which this route no longer
// guards with its own try/catch around identity resolution.
let startRunThrows: Error | null = null;

const runStarter: WorkflowRunStarter = {
  startRun: async (args) => {
    startRunCalls.push(args);
    if (startRunThrows) throw startRunThrows;
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
  // Trigger-payload enrichment (identity, brief-source preferences, the
  // manual-refresh createdAfter window) now happens INSIDE startRun (the
  // shared trigger-payload-enrichment registry) — this route only builds the
  // base payload and forwards `source: "manual"`. Enrichment itself is
  // covered end-to-end by workflow-run-starter.test.ts's heartbeat tests.
  it("starts a run for the caller's heartbeat kind, source manual, with the schedule's stored payload plus reason override", async () => {
    startRunCalls = [];
    startRunThrows = null;
    startRunResult = { ok: true, deploymentId: "dep-1", runId: "run-1" };
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
    expect(call?.input.reason).toBe("manual-brief");
    // No enrichment fields are present — this route no longer computes them.
    expect("enabledSources" in call!.input).toBe(false);
    expect("userAddress" in call!.input).toBe(false);
    expect("createdAfter" in call!.input).toBe(false);
  });

  it("403s when the caller has no membership", async () => {
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-none"));
    expect(res.status).toBe(403);
  });

  it("rejects a second manual run from the same member within the window", async () => {
    startRunCalls = [];
    startRunThrows = null;
    startRunResult = { ok: true, deploymentId: "dep-1", runId: "run-1" };
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
    startRunThrows = null;
    startRunResult = { ok: true, deploymentId: "dep-2", runId: "run-2" };
    const app = mountApp();
    const a = await app.fetch(req("/me/brief-run", "user-a"));
    expect(a.status).toBe(200);
    const b = await app.fetch(req("/me/brief-run", "user-b"));
    expect(b.status).toBe(200);
    expect(startRunCalls).toHaveLength(2);
  });

  it("surfaces a generic message, not the internal reason, when the run fails to start", async () => {
    startRunCalls = [];
    startRunThrows = null;
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
    startRunThrows = null;
    startRunResult = { ok: true, deploymentId: "dep-2", runId: "run-2" };
    scheduleRowsByPrincipal["principal-a"] = [];
    const app = mountApp();
    const res = await app.fetch(req("/me/brief-run", "user-a"));
    expect(res.status).toBe(200);
    const call = startRunCalls[0];
    expect(call?.input).toEqual({ reason: "manual-brief" });
    scheduleRowsByPrincipal["principal-a"] = [
      {
        workflowKind: HEARTBEAT_KIND,
        intervalMinutes: 1440,
        anchorMinuteUtc: 13 * 60,
        triggerPayload: { reason: "scheduled-heartbeat" },
      },
    ];
  });

  it("does not consume the rate window when the run fails to start", async () => {
    startRunCalls = [];
    startRunThrows = null;
    startRunResult = {
      ok: false,
      reason: "delivery_failed",
      message: "sidecar exploded",
    };
    const app = mountApp();
    const first = await app.fetch(req("/me/brief-run", "user-a"));
    expect(first.status).toBe(502);
    startRunResult = { ok: true, deploymentId: "dep-3", runId: "run-3" };
    const second = await app.fetch(req("/me/brief-run", "user-a"));
    expect(second.status).toBe(200);
  });

  // BLOCKING 2 (review): the registry's identity resolution now happens
  // INSIDE startRun, unguarded by this route's own try/catch (that guard was
  // removed along with the route's own pre-enrichment). A failure there must
  // still refund the rate-limit slot and return the same crafted 502 as any
  // other startRun failure — not an unhandled 500 that also burns the
  // member's one-per-10-min slot.
  it("refunds the rate-limit slot and returns the crafted 502 when startRun's enrichment fails (e.g. identity resolution)", async () => {
    startRunCalls = [];
    startRunThrows = new Error("principal not found: principal-a");
    const app = mountApp();
    const first = await app.fetch(req("/me/brief-run", "user-a"));
    expect(first.status).toBe(502);
    const body = await first.json();
    expect(body).toEqual({ error: "The brief could not be started" });
    expect(JSON.stringify(body)).not.toContain("principal not found");

    // The slot was refunded — a second attempt for the same member is not
    // rate-limited, and reaches startRun again.
    startRunThrows = null;
    startRunResult = { ok: true, deploymentId: "dep-4", runId: "run-4" };
    const second = await app.fetch(req("/me/brief-run", "user-a"));
    expect(second.status).toBe(200);
    expect(startRunCalls).toHaveLength(2);
  });
});
