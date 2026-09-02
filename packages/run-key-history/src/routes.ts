// Operator read surface over `./diagnostics.ts`, mounted the same way
// `@corbits/insights`' `createInsightsRoutes` is (see its routes.ts):
// one `Hono<TenantEnv>` app with its own `requireGrant` gate, mounted
// under the platform's native tenant middleware by the host app. Every
// route here is read-only; nothing here ever writes `run_key_history`
// or `workflow_run`.
import { Hono } from "hono";
import { type } from "arktype";

import type { DB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@workbench/hub-client";

import {
  countRunIdentityStates,
  getRunIdentityStatus,
  getRunKeyLifecycle,
} from "./diagnostics";

const SummaryQuery = type({
  "sidecarId?": "string",
});

export type CreateRunKeyHistoryRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
};

export function createRunKeyHistoryRoutes(
  deps: CreateRunKeyHistoryRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  /**
   * Per-run identity: its full ordered key lifecycle plus the current
   * comparison against `workflow_run.public_key`. Diagnosing "why is
   * this run not running" starts here — no log-reading, no manually
   * comparing a disk key file against a database column.
   */
  app.get(
    "/runs/:runAddress",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const runAddress = c.req.param("runAddress");
      const [status, lifecycle] = await Promise.all([
        getRunIdentityStatus(deps.db, runAddress),
        getRunKeyLifecycle(deps.db, runAddress),
      ]);
      if (status === null) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "run not found",
          }),
          404,
        );
      }
      return c.json({ status, lifecycle });
    },
  );

  /**
   * Counts of runs by identity state for the calling tenant, optionally
   * narrowed to one sidecar — the incident number ("13 runs failing
   * their reconnect challenge, 1 with a diverged key") surfaced as data
   * instead of inferred from log noise.
   */
  app.get(
    "/summary",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const raw = SummaryQuery(c.req.query());
      if (raw instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid query: ${raw.summary}`,
          }),
          400,
        );
      }
      const tenant = c.get("tenant");
      const scope =
        raw.sidecarId === undefined
          ? { tenantId: tenant.id }
          : { tenantId: tenant.id, sidecarId: raw.sidecarId };
      const counts = await countRunIdentityStates(deps.db, scope);
      return c.json(counts);
    },
  );

  return app;
}
