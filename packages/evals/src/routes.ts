// Read-only HTTP surface over `EvalRunStore` (CL-6465): recent eval runs
// across every eval, and one run's full step/scorer detail. Mounted the
// same way `@corbits/insights` and `@corbits/run-key-history` mount their
// own routes.ts — one `Hono<TenantEnv>` app gated by `requireGrant`, no
// data partition by tenant (eval runs aren't tenant-owned, same as
// `run_key_history`; the tenant middleware here is only the grant gate).
//
// Every field below is either already human-readable (`evalName`,
// `configName`, scorer `name`/`reason`) or a dedicated `id` a UI never
// prints as text, only follows for `/runs/:runId` — no `run_`/`wfd_`-style
// identifier ever lands in a display field.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { ALL_EVALS } from "./cases/index.ts";
import type { EvalRunRecord, EvalRunStore } from "./store/store.ts";
import { makeErrorEnvelope } from "@workbench/hub-client";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const RunsQuery = type({
  "limit?": "string",
  "evalName?": "string",
});

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return undefined;
  }
  return parsed;
}

function evalDescription(evalName: string): string | null {
  return ALL_EVALS.find((e) => e.name === evalName)?.description ?? null;
}

function scorerTally(record: EvalRunRecord): {
  passed: number;
  failed: number;
  skipped: number;
} {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const step of record.steps) {
    for (const report of step.scorerReports) {
      if (report.skipped) skipped += 1;
      else if (report.pass) passed += 1;
      else failed += 1;
    }
  }
  return { passed, failed, skipped };
}

function toSummary(record: EvalRunRecord) {
  return {
    id: record.id,
    evalName: record.evalName,
    evalDescription: evalDescription(record.evalName),
    configName: record.configName,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    stepCount: record.steps.length,
    scorerTally: scorerTally(record),
  };
}

function toDetail(record: EvalRunRecord) {
  return {
    id: record.id,
    evalName: record.evalName,
    evalDescription: evalDescription(record.evalName),
    configName: record.configName,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    steps: record.steps,
  };
}

export type CreateEvalRunRoutesDeps = {
  store: EvalRunStore;
  requireGrant: RequireGrant;
};

export function createEvalRunRoutes(
  deps: CreateEvalRunRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  /**
   * Recent eval runs across every eval (or one eval, via `?evalName=`),
   * newest first — the run history list.
   */
  app.get("/runs", deps.requireGrant("eval-run:*", "read"), async (c) => {
    const raw = RunsQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid query: ${raw.summary}`,
        }),
        400,
      );
    }
    const limit = parseLimit(raw.limit);
    if (limit === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `limit must be an integer between 1 and ${MAX_LIMIT}`,
        }),
        400,
      );
    }
    const records =
      raw.evalName === undefined
        ? await deps.store.recentAcrossEvals(limit)
        : await deps.store.recent(raw.evalName, limit);
    return c.json({ runs: records.map(toSummary) });
  });

  /**
   * One run's full step-by-step transcript and scorer reports.
   */
  app.get(
    "/runs/:runId",
    deps.requireGrant("eval-run:*", "read"),
    async (c) => {
      const runId = c.req.param("runId");
      const record = await deps.store.get(runId);
      if (record === null) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "eval run not found",
          }),
          404,
        );
      }
      return c.json(toDetail(record));
    },
  );

  return app;
}
