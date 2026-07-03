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
import { getTenantActivityPage } from "../services/principal-activity";

const log = getLogger(["hub", "tenant-activity"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type TenantActivityRouteEnv = Env & {
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

export type CreateTenantActivityRouterDeps = {
  db: HubDb;
};

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return null;
  return value;
}

export function createTenantActivityRouter({
  db,
}: CreateTenantActivityRouterDeps): Hono<TenantActivityRouteEnv> {
  const app = new Hono<TenantActivityRouteEnv>();

  app.get(
    "/timeline",
    describeRoute({
      tags: ["Activity"],
      summary: "Paginated tenant-wide activity timeline",
      description:
        "The DEFAULT Insights feed (CL-2743): every registered activity source merged across ALL principals in the tenant — every user, every agent instance, every workflow run — into one keyset-paginated timeline. Gated by tenant membership only (`resolveTenant`); cross-tenant activity never resolves because each source carries a mandatory tenant predicate. The cursor is opaque; tenant scope always comes from the authenticated path, never the cursor.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the timeline.",
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
          description: "One tenant-wide timeline page, newest first",
          content: {
            "application/json": { schema: resolver(ActivityResponse) },
          },
        },
        400: {
          description: "Invalid limit or cursor",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");

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
        const page = await getTenantActivityPage({
          db,
          tenantId: tenant.id,
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
        log.error("Tenant activity failed for tenant {tenantId}: {error}", {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          {
            error: {
              code: "internal_error",
              message: "Failed to load tenant activity",
            },
          },
          500,
        );
      }
    },
  );

  return app;
}
