import { describe, expect, it, mock } from "bun:test";
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
      return { ok: true, deploymentId: "dep-1", runId: "run-1" };
    },
  };
  return { starter, calls };
}

/** Never resolves, to prove the handler responds without awaiting startRun. */
function makeHangingStarter(): {
  starter: WorkflowRunStarter;
  calls: Parameters<WorkflowRunStarter["startRun"]>[0][];
} {
  const calls: Parameters<WorkflowRunStarter["startRun"]>[0][] = [];
  const starter: WorkflowRunStarter = {
    startRun: (args) => {
      calls.push(args);
      return new Promise(() => {});
    },
  };
  return { starter, calls };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
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
  opts: { secret?: string; id?: string; ip?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.secret !== undefined) headers.set("x-trigger-secret", opts.secret);
  headers.set("x-forwarded-for", opts.ip ?? "203.0.113.1");
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
    await waitUntil(() => calls.length > 0);
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

  it("404s on the wrong secret without ever reading the request body", async () => {
    const { db } = makeDb(enabledRow());
    const { starter, calls } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    // A body far past the 32KB ceiling: if the handler read it before
    // rejecting the bad secret, this would 413 instead of 404 (or, on a real
    // chunked request, buffer the whole thing before ever checking auth).
    const hugeBody = JSON.stringify({ blob: "x".repeat(1_000_000) });
    const request = req(hugeBody, { secret: "wrong-secret" });
    const textSpy = mock(async () => hugeBody);
    Object.defineProperty(request, "text", { value: textSpy });

    const res = await app.fetch(request);

    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
    expect(textSpy).not.toHaveBeenCalled();
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

  it("413s an authenticated body over 32KB without starting a run", async () => {
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
    await waitUntil(() => markedFiredIds.length > 0);
    expect(markedFiredIds).toEqual([TRIGGER_ID]);
  });

  it("responds 202 without waiting for startRun to resolve", async () => {
    const { db } = makeDb(enabledRow());
    const { starter, calls } = makeHangingStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const res = await app.fetch(req(JSON.stringify({}), { secret: SECRET }));

    // The response already came back even though startRun's promise (from
    // makeHangingStarter) never resolves — proof the dispatch is detached.
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    await waitUntil(() => calls.length > 0);
    expect(calls.length).toBe(1);
  });

  it("rate-limits repeated fires against the same trigger from the same IP", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const responses = [];
    for (let i = 0; i < 7; i++) {
      responses.push(
        await app.fetch(
          req(JSON.stringify({}), { secret: SECRET, ip: "203.0.113.9" }),
        ),
      );
    }
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202).length).toBe(6);
    expect(statuses.filter((s) => s === 429).length).toBe(1);
  });

  it("does not let one IP's floods rate-limit a different IP hitting the same trigger", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    for (let i = 0; i < 6; i++) {
      const res = await app.fetch(
        req(JSON.stringify({}), { secret: SECRET, ip: "203.0.113.9" }),
      );
      expect(res.status).toBe(202);
    }
    // The attacker's IP is now at the limit; a different caller (e.g. the
    // legitimate owner) hitting the same trigger from a different IP is
    // unaffected.
    const fromOtherIp = await app.fetch(
      req(JSON.stringify({}), { secret: SECRET, ip: "198.51.100.5" }),
    );
    expect(fromOtherIp.status).toBe(202);
  });

  it("does not rate-limit when there is no trusted forwarded-for hop", async () => {
    const { db } = makeDb(enabledRow());
    const { starter } = makeStarter();
    const app = new Hono();
    app.route("/", createWebhookTriggerFireRouter({ db, runStarter: starter }));

    const bareRequest = () => {
      const headers = new Headers({
        "Content-Type": "application/json",
        "x-trigger-secret": SECRET,
      });
      return new Request(`http://local/triggers/webhook/${TRIGGER_ID}`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
    };

    for (let i = 0; i < 8; i++) {
      const res = await app.fetch(bareRequest());
      expect(res.status).toBe(202);
    }
  });
});
