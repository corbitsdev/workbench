// Tenant-scoped Insights read API. Mounted under the platform's native
// tenant middleware; every number that cannot be known is returned as
// null, never a fabricated zero.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  activityByDay,
  emptyToolCallReader,
  summarizeUsage,
  type RunTraceReader,
  type ToolCallReader,
} from "./queries";
import type { UsageStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const RangeQuery = type({
  "from?": "string",
  "to?": "string",
});

function parseRange(raw: { from?: string; to?: string }): {
  from?: Date;
  to?: Date;
} | type.errors {
  const opts: { from?: Date; to?: Date } = {};
  if (raw.from !== undefined) {
    const d = new Date(raw.from);
    if (Number.isNaN(d.getTime())) {
      return type.errors as unknown as type.errors;
    }
    opts.from = d;
  }
  if (raw.to !== undefined) {
    const d = new Date(raw.to);
    if (Number.isNaN(d.getTime())) {
      return type.errors as unknown as type.errors;
    }
    opts.to = d;
  }
  return opts;
}

export type CreateInsightsRoutesDeps = {
  store: UsageStore;
  requireGrant: RequireGrant;
  runTraceReader?: RunTraceReader;
  toolCallReader?: ToolCallReader;
};

export function createInsightsRoutes(deps: CreateInsightsRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const tools = deps.toolCallReader ?? emptyToolCallReader();

  app.get("/usage", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`), 400);
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", "invalid from/to timestamp"), 400);
    }
    const tenant = c.get("tenant");
    const summary = await summarizeUsage(deps.store, tenant.id, range);
    return c.json(summary);
  });

  app.get("/activity", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`), 400);
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", "invalid from/to timestamp"), 400);
    }
    const tenant = c.get("tenant");
    const days = await activityByDay(deps.store, tenant.id, range);
    return c.json({ days });
  });

  app.get("/tools", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`), 400);
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(ErrorEnvelope("bad_request", "invalid from/to timestamp"), 400);
    }
    const tenant = c.get("tenant");
    const toolsSummary = await tools.summarize(tenant.id, range);
    return c.json({ tools: toolsSummary });
  });

  app.get("/runs/:runId/trace", deps.requireGrant("insights:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const runId = c.req.param("runId");
    if (deps.runTraceReader === undefined) {
      return c.json(
        {
          runId,
          spans: null,
          absent: "run_trace_reader_not_mounted",
        },
        200,
      );
    }
    const trace = await deps.runTraceReader.getTrace(tenant.id, runId);
    if (trace === null) {
      return c.json(ErrorEnvelope("not_found", "run not found"), 404);
    }
    return c.json(trace);
  });

  return app;
}
