// Route-level tests: request parsing, grant gating, and error-envelope
// mapping against an in-memory fake store. Real Postgres persistence is
// covered in store/store.test.ts.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createEvalRunRoutes } from "./routes.ts";
import type { EvalRunRecord, EvalRunStore } from "./store/store.ts";

const TENANT = { id: "tnt_1" };

function fixtureRecord(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    id: "evalrun_1",
    evalName: "ai-daily-research",
    configName: "default",
    startedAt: "2026-08-16T00:00:00.000Z",
    finishedAt: "2026-08-16T00:01:00.000Z",
    steps: [
      {
        stepIndex: 0,
        turn: { human: "hi", replyText: "hello", toolCalls: [] },
        scorerReports: [
          {
            name: "asksQuestions",
            score: 1,
            pass: true,
            reason: "ok",
            stepIndex: 0,
          },
          {
            name: "judge",
            score: 0,
            pass: false,
            reason: "missed it",
            stepIndex: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function fakeStore(records: EvalRunRecord[] = []): EvalRunStore {
  return {
    async save() {
      throw new Error("not used by these tests");
    },
    async recent(evalName, limit) {
      return records.filter((r) => r.evalName === evalName).slice(0, limit);
    },
    async recentAcrossEvals(limit) {
      return records.slice(0, limit);
    },
    async get(id) {
      return records.find((r) => r.id === id) ?? null;
    },
  };
}

function buildApp(
  store: EvalRunStore,
  opts?: { forbidden?: boolean },
): Hono<TenantEnv> {
  const routes = createEvalRunRoutes({
    store,
    requireGrant: () => async (c, next) => {
      if (opts?.forbidden === true) {
        return c.json({ error: { code: "forbidden", message: "no" } }, 403);
      }
      await next();
    },
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

test("GET /runs returns an empty list when no runs are recorded", async () => {
  const app = buildApp(fakeStore());
  const response = await app.request("/runs");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { runs: unknown[] };
  expect(body.runs).toEqual([]);
});

test("GET /runs returns shaped summaries across evals, newest first order preserved", async () => {
  const record = fixtureRecord();
  const app = buildApp(fakeStore([record]));
  const response = await app.request("/runs");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    runs: {
      id: string;
      evalName: string;
      evalDescription: string | null;
      configName: string;
      stepCount: number;
      scorerTally: { passed: number; failed: number; skipped: number };
    }[];
  };
  expect(body.runs).toHaveLength(1);
  const run = body.runs[0];
  expect(run?.id).toBe("evalrun_1");
  expect(run?.evalName).toBe("ai-daily-research");
  expect(typeof run?.evalDescription).toBe("string");
  expect(run?.configName).toBe("default");
  expect(run?.stepCount).toBe(1);
  expect(run?.scorerTally).toEqual({ passed: 1, failed: 1, skipped: 0 });
});

test("GET /runs?evalName= filters to that eval only", async () => {
  const a = fixtureRecord({ id: "evalrun_a", evalName: "ai-daily-research" });
  const b = fixtureRecord({ id: "evalrun_b", evalName: "docs-on-sdk-change" });
  const app = buildApp(fakeStore([a, b]));
  const response = await app.request("/runs?evalName=docs-on-sdk-change");
  const body = (await response.json()) as { runs: { id: string }[] };
  expect(body.runs).toHaveLength(1);
  expect(body.runs[0]?.id).toBe("evalrun_b");
});

test("GET /runs with an unknown eval name yields a null description, not a crash", async () => {
  const record = fixtureRecord({ evalName: "not-a-real-eval" });
  const app = buildApp(fakeStore([record]));
  const response = await app.request("/runs");
  const body = (await response.json()) as {
    runs: { evalDescription: string | null }[];
  };
  expect(body.runs[0]?.evalDescription).toBeNull();
});

test("GET /runs?limit=0 400s", async () => {
  const app = buildApp(fakeStore());
  const response = await app.request("/runs?limit=0");
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("GET /runs?limit=not-a-number 400s", async () => {
  const app = buildApp(fakeStore());
  const response = await app.request("/runs?limit=abc");
  expect(response.status).toBe(400);
});

test("GET /runs/:runId returns the run's steps and scorer reports", async () => {
  const record = fixtureRecord();
  const app = buildApp(fakeStore([record]));
  const response = await app.request("/runs/evalrun_1");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    id: string;
    steps: unknown[];
  };
  expect(body.id).toBe("evalrun_1");
  expect(body.steps).toEqual(record.steps);
});

test("GET /runs/:runId 404s for an unknown id", async () => {
  const app = buildApp(fakeStore());
  const response = await app.request("/runs/evalrun_missing");
  expect(response.status).toBe(404);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("not_found");
});

test("GET /runs is gated by requireGrant", async () => {
  const app = buildApp(fakeStore(), { forbidden: true });
  const response = await app.request("/runs");
  expect(response.status).toBe(403);
});

test("GET /runs/:runId is gated by requireGrant", async () => {
  const app = buildApp(fakeStore(), { forbidden: true });
  const response = await app.request("/runs/evalrun_1");
  expect(response.status).toBe(403);
});
