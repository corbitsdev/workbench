import { authorize, type GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  MomentDetailSchema,
  timelineEntryKinds,
  TimelineEntrySchema,
  type TimelineCursor,
} from "@workbench/timeline";
import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";

import type { HubDb } from "../db";
import { getMomentDetail } from "../services/moment-detail";
import { getPrincipalActivityPage } from "../services/principal-activity";

const log = getLogger(["hub", "principal-activity"]);

const ACTIVITY_RESOURCE = "activity:principal";
const ACTIVITY_ACTION = "read";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type PrincipalActivityRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const ActivityResponse = type({
  entries: TimelineEntrySchema.array(),
  nextCursor: "string | null",
});
const ErrorResponse = type({
  error: { code: "string", message: "string" },
});

export type CreatePrincipalActivityRouterDeps = {
  db: HubDb;
  grantStore: GrantStore;
};

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return null;
  return value;
}

export function createPrincipalActivityRouter({
  db,
  grantStore,
}: CreatePrincipalActivityRouterDeps): Hono<PrincipalActivityRouteEnv> {
  const app = new Hono<PrincipalActivityRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Activity"],
      summary: "Paginated per-principal activity timeline",
      description:
        "Merges every registered activity source (sessions, messages, inference turns, tool calls, workflow runs, artifacts, uploads, memory, approvals, feedback, grants, credentials) into one keyset-paginated timeline for a principal. A principal may read their own timeline; reading another principal's requires an `activity:principal`/`read` grant. The cursor is opaque; the tenant and principal scope always come from the authenticated path, never the cursor.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the timeline.",
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          description: "Principal whose activity to list.",
          schema: { type: "string" },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description: `Page size, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
          schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          description:
            "Opaque keyset cursor from a previous page's `nextCursor`.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "One timeline page, newest first",
          content: {
            "application/json": { schema: resolver(ActivityResponse) },
          },
        },
        400: {
          description: "Invalid limit or cursor",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "Caller is neither the target principal nor granted activity read",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const caller = c.get("principal");
      const targetPrincipalId = c.req.param("principalId");
      if (targetPrincipalId === undefined || targetPrincipalId === "") {
        return c.json(
          { error: { code: "bad_request", message: "Missing principalId" } },
          400,
        );
      }

      if (caller.id !== targetPrincipalId) {
        const decision = await authorize(
          grantStore,
          caller.id,
          tenant.id,
          ACTIVITY_RESOURCE,
          ACTIVITY_ACTION,
        );
        if (decision.effect !== "allow") {
          return c.json(
            {
              error: {
                code: "forbidden",
                message: "You do not have permission to view this activity",
              },
            },
            403,
          );
        }
      }

      const limit = parseLimit(c.req.query("limit"));
      if (limit === null) {
        return c.json(
          {
            error: {
              code: "bad_request",
              message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
            },
          },
          400,
        );
      }

      const cursorToken = c.req.query("cursor");
      let cursor: TimelineCursor | undefined;
      if (cursorToken !== undefined && cursorToken !== "") {
        try {
          cursor = decodeTimelineCursor(cursorToken);
        } catch {
          return c.json(
            { error: { code: "bad_request", message: "Invalid cursor" } },
            400,
          );
        }
      }

      try {
        const page = await getPrincipalActivityPage({
          db,
          tenantId: tenant.id,
          principalId: targetPrincipalId,
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return c.json({
          entries: page.entries,
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeTimelineCursor(page.nextCursor),
        });
      } catch (error) {
        log.error(
          "Principal activity failed for tenant {tenantId} principal {principalId}: {error}",
          {
            tenantId: tenant.id,
            principalId: targetPrincipalId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return c.json(
          {
            error: {
              code: "internal_error",
              message: "Failed to load principal activity",
            },
          },
          500,
        );
      }
    },
  );

  app.get(
    "/:kind/:id/detail",
    describeRoute({
      tags: ["Activity"],
      summary: "Expand one activity moment into its rich detail",
      description:
        "The paginated timeline is a lean projection (id, kind, summary). This route enriches a single OPENED moment by joining the source's rich columns: tool-call inputs/outputs (from `turn_part`), an inference turn's model, duration, and ordered parts, or a workflow run's recorded duration and outcome (from the analytics fact tables). Same `activity:principal`/`read` authz as the timeline, so cross-principal detail is gated identically. Returns 404 when the moment does not resolve within the caller's attribution scope.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the moment.",
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          description: "Principal whose moment to expand.",
          schema: { type: "string" },
        },
        {
          name: "kind",
          in: "path",
          required: true,
          description: "The moment's timeline kind (e.g. `tool_call`).",
          schema: { type: "string", enum: [...timelineEntryKinds] },
        },
        {
          name: "id",
          in: "path",
          required: true,
          description: "The moment's timeline entry id.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The expanded moment detail",
          content: {
            "application/json": { schema: resolver(MomentDetailSchema) },
          },
        },
        403: {
          description:
            "Caller is neither the target principal nor granted activity read",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such moment within the caller's scope",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const caller = c.get("principal");
      const targetPrincipalId = c.req.param("principalId");
      const kind = c.req.param("kind");
      const id = c.req.param("id");
      if (
        targetPrincipalId === undefined ||
        targetPrincipalId === "" ||
        kind === undefined ||
        kind === "" ||
        id === undefined ||
        id === ""
      ) {
        return c.json(
          { error: { code: "bad_request", message: "Missing moment path" } },
          400,
        );
      }
      if (!(timelineEntryKinds as readonly string[]).includes(kind)) {
        return c.json(
          { error: { code: "bad_request", message: "Unknown moment kind" } },
          400,
        );
      }

      if (caller.id !== targetPrincipalId) {
        const decision = await authorize(
          grantStore,
          caller.id,
          tenant.id,
          ACTIVITY_RESOURCE,
          ACTIVITY_ACTION,
        );
        if (decision.effect !== "allow") {
          return c.json(
            {
              error: {
                code: "forbidden",
                message: "You do not have permission to view this activity",
              },
            },
            403,
          );
        }
      }

      try {
        const detail = await getMomentDetail({
          db,
          tenantId: tenant.id,
          principalId: targetPrincipalId,
          kind,
          id,
        });
        if (detail === null) {
          return c.json(
            { error: { code: "not_found", message: "Moment not found" } },
            404,
          );
        }
        return c.json(detail);
      } catch (error) {
        log.error(
          "Moment detail failed for tenant {tenantId} principal {principalId} moment {id}: {error}",
          {
            tenantId: tenant.id,
            principalId: targetPrincipalId,
            id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return c.json(
          {
            error: {
              code: "internal_error",
              message: "Failed to load moment detail",
            },
          },
          500,
        );
      }
    },
  );

  return app;
}
