// Tenant-scoped Insights read API. Mounted under the platform's native
// tenant middleware; every number that cannot be known is returned as
// null, never a fabricated zero. usage/activity/tools roll up the
// requested tenant's whole descendant subtree when `deps.db` is wired
// (see resolveScope) — the same route serves a single workbench's own
// numbers (leaf, no descendants) and a workspace's cross-workbench
// aggregate (parent, its child workbenches). `/scope` is the read-only
// counterpart a caller uses to discover that shape: its own name, its
// parent (if any), and the sibling workbenches to switch between.
import { Hono } from "hono";
import { type } from "arktype";
import { eq } from "drizzle-orm";

import { getDescendantTenants, schema, type DB } from "@intx/db";
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

function parseRange(raw: { from?: string; to?: string }):
  | {
      from?: Date;
      to?: Date;
    }
  | type.errors {
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
  /**
   * Tenant-hierarchy handle for scope resolution. usage/activity/tools
   * aggregate over the requested tenant plus every descendant it has
   * (see getDescendantTenants) — no separate "aggregate" flag or route:
   * calling with a workbench's own id stays a single-tenant view (it has
   * no descendants), calling with its workspace parent rolls up every
   * child workbench, at this query layer rather than one fetch per
   * tenant. Omitted, every query stays scoped to exactly the requested
   * tenant (no hierarchy lookup, same behavior as before this scope
   * existed).
   */
  db?: DB["db"];
};

async function resolveScope(
  db: DB["db"] | undefined,
  tenantId: string,
): Promise<readonly string[]> {
  if (db === undefined) return [tenantId];
  return getDescendantTenants(db, tenantId);
}

export function createInsightsRoutes(
  deps: CreateInsightsRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const tools = deps.toolCallReader ?? emptyToolCallReader();

  app.get("/usage", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`),
        400,
      );
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", "invalid from/to timestamp"),
        400,
      );
    }
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const summary = await summarizeUsage(deps.store, scope, range);
    return c.json(summary);
  });

  app.get("/activity", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`),
        400,
      );
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", "invalid from/to timestamp"),
        400,
      );
    }
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const days = await activityByDay(deps.store, scope, range);
    return c.json({ days });
  });

  app.get("/tools", deps.requireGrant("insights:*", "read"), async (c) => {
    const raw = RangeQuery(c.req.query());
    if (raw instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid query: ${raw.summary}`),
        400,
      );
    }
    const range = parseRange(raw);
    if (range instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", "invalid from/to timestamp"),
        400,
      );
    }
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const toolsSummary = await tools.summarize(scope, range);
    return c.json({ tools: toolsSummary });
  });

  app.get("/scope", deps.requireGrant("insights:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const self = { tenantId: tenant.id, name: tenant.name };
    if (deps.db === undefined || tenant.parentId === null) {
      return c.json({
        tenantId: tenant.id,
        name: tenant.name,
        parent: null,
        workbenches: [self],
      });
    }
    const parentRow = await deps.db.query.tenant.findFirst({
      where: eq(schema.tenant.id, tenant.parentId),
      columns: { id: true, name: true },
    });
    if (parentRow === undefined) {
      return c.json({
        tenantId: tenant.id,
        name: tenant.name,
        parent: null,
        workbenches: [self],
      });
    }
    const siblings = await deps.db.query.tenant.findMany({
      where: eq(schema.tenant.parentId, tenant.parentId),
      columns: { id: true, name: true },
    });
    return c.json({
      tenantId: tenant.id,
      name: tenant.name,
      parent: { tenantId: parentRow.id, name: parentRow.name },
      workbenches: siblings.map((s) => ({ tenantId: s.id, name: s.name })),
    });
  });

  app.get(
    "/runs/:runId/trace",
    deps.requireGrant("insights:*", "read"),
    async (c) => {
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
    },
  );

  return app;
}
