// `GET /api/tenants/:tenantId/workflows/targets` — the HTTP face of
// ./targets.ts. No coarse `requireGrant` in front: each row is authorized
// individually inside `listRoutineTargets`, and a principal holding no
// definition grant gets an empty page, not a 403 that would confirm the
// tenant has definitions to hide.

import { Hono } from "hono";
import { type } from "arktype";
import type { TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@workbench/hub-client";

import {
  InvalidRoutineTargetCursorError,
  ROUTINE_TARGETS_DEFAULT_LIMIT,
  ROUTINE_TARGETS_MAX_LIMIT,
  listRoutineTargets,
  type RoutineTargetsDeps,
} from "./targets";

const LimitParam = type("string.integer.parse").narrow(
  (limit) => limit >= 1 && limit <= ROUTINE_TARGETS_MAX_LIMIT,
);

export function createRoutineTargetRoutes(deps: RoutineTargetsDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", async (c) => {
    const rawLimit = c.req.query("limit");
    const limit =
      rawLimit === undefined ? ROUTINE_TARGETS_DEFAULT_LIMIT : LimitParam(rawLimit);
    if (limit instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `limit must be an integer between 1 and ${String(ROUTINE_TARGETS_MAX_LIMIT)}.`,
        }),
        400,
      );
    }
    const cursor = c.req.query("cursor");
    try {
      const page = await listRoutineTargets(deps, {
        tenantId: c.get("tenant").id,
        principalId: c.get("principal").id,
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof InvalidRoutineTargetCursorError) {
        return c.json(
          makeErrorEnvelope({ code: "bad_request", userMessage: error.message }),
          400,
        );
      }
      throw error;
    }
  });

  return app;
}
