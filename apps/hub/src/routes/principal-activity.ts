import { authorize, type GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  TimelineEntrySchema,
  type TimelineCursor,
} from "@workbench/timeline";
import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";

import type { HubDb } from "../db";
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

  return app;
}
