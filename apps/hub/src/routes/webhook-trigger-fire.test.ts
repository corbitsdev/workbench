import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { HubDb } from "../db";
import type { WorkflowRunStarter } from "../services/workflow-run-starter";
import { createWebhookTriggerFireRouter } from "./webhook-trigger-fire";

function hashOf(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

type Row = {
  id: string;
  tenantId: string;
  ownerMemberPrincipalId: string;
  workflowKind: string;
  secretHash: string;
  enabled: boolean;
  createdAt: Date;
  lastFiredAt: Date | null;
};

function makeDb(row: Row | null): {
  db: HubDb;
  markedFiredIds: string[];
} {
  const markedFiredIds: string[] = [];
  const db = {
    query: {
      workflowTrigger: {
        findFirst: async () => row,
      },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (patch["lastFiredAt"] && row) markedFiredIds.push(row.id);
          return [];
        },
      }),
    }),
  };
  return { db: db as unknown as HubDb, markedFiredIds };
}

function makeStarter(): {
  starter: WorkflowRunStarter;
  calls: Parameters<WorkflowRunStarter["startRun"]>[0][];
} {
  const calls: Parameters<WorkflowRunStarter["startRun"]>[0][] = [];
  const starter: WorkflowRunStarter = {
    startRun: async (args) => {
      calls.push(args);
      return { ok: true, deploymentId: "dep-1" };
    },
  };
  return { starter, calls };
}

const TRIGGER_ID = "11111111-1111-1111-1111-111111111111";
const SECRET = "correct-horse-battery-staple";

function enabledRow(overrides: Partial<Row> = {}): Row {
  return {
    id: TRIGGER_ID,
    tenantId: "tenant-1",
    ownerMemberPrincipalId: "principal-owner",
    workflowKind: "deck",
    secretHash: hashOf(SECRET),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastFiredAt: null,
    ...overrides,
  };
}

function req(
  body: string,
  opts: { secret?: string; id?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.secret !== undefined) headers.set("x-trigger-secret", opts.secret);
  return new Request(`http://local/triggers/webhook/${opts.id ?? TRIGGER_ID}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /triggers/webhook/:triggerId", () => {
  it("fires the run with owner attribution and the webhook envelope on a correct secret", async () => {
    const { db } = makeDb(enabledRow());
    const { starter, calls } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(
      req(JSON.stringify({ hello: "world" }), { secret: SECRET }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(calls).toEqual([
      {
        kind: "deck",
        tenantId: "tenant-1",
        creatorPrincipalId: "principal-owner",
        input: {
          reason: "webhook",
          triggerId: TRIGGER_ID,
          payload: { hello: "world" },
        },
      },
    ]);
  });

  it("404s on the wrong secret without starting a run", async () => {
    const { db } = makeDb(enabledRow());
    const { starter, calls } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(
      req(JSON.stringify({}), { secret: "wrong-secret" }),
    );

    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it("404s when the trigger id is unknown", async () => {
    const { db } = makeDb(null);
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(req(JSON.stringify({}), { secret: SECRET }));
    expect(res.status).toBe(404);
  });

  it("404s on a disabled trigger, even with the correct secret", async () => {
    const { db } = makeDb(enabledRow({ enabled: false }));
    const { starter, calls } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(req(JSON.stringify({}), { secret: SECRET }));
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it("404s on a malformed trigger id", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(
      req(JSON.stringify({}), { secret: SECRET, id: "not-a-uuid" }),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the secret header is missing", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(req(JSON.stringify({})));
    expect(res.status).toBe(404);
  });

  it("413s a body over 32KB without looking up the trigger", async () => {
    const { db } = makeDb(enabledRow());
    const { starter, calls } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const oversized = JSON.stringify({ blob: "x".repeat(40_000) });
    const res = await app.fetch(req(oversized, { secret: SECRET }));
    expect(res.status).toBe(413);
    expect(calls.length).toBe(0);
  });

  it("marks last_fired_at and still 202s when startRun fails downstream", async () => {
    const { db, markedFiredIds } = makeDb(enabledRow());
    const failingStarter: WorkflowRunStarter = {
      startRun: async () => ({
        ok: false,
        reason: "not_found",
        message: "no deployed workflow",
      }),
    };
    const app = new Hono();
    app.route(
      "/",
      createWebhookTriggerFireRouter({ db, runStarter: failingStarter }),
    );

    const res = await app.fetch(req(JSON.stringify({}), { secret: SECRET }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(markedFiredIds).toEqual([TRIGGER_ID]);
  });

  it("rate-limits repeated fires against the same trigger", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const responses = [];
    for (let i = 0; i < 7; i++) {
      responses.push(
        await app.fetch(req(JSON.stringify({}), { secret: SECRET })),
      );
    }
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202).length).toBe(6);
    expect(statuses.filter((s) => s === 429).length).toBe(1);
  });
});
