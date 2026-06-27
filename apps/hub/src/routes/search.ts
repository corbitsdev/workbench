import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { searchTenant, SearchResponseSchema } from "../services/search";

const log = getLogger(["api", "search"]);

type SearchRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const QUERY_PARAMS = [
  {
    name: "q",
    in: "query" as const,
    required: true,
    description: "Search query.",
    schema: { type: "string" as const },
  },
  {
    name: "page",
    in: "query" as const,
    required: false,
    description:
      "Zero-based page; each source returns 5 rows at OFFSET page*5.",
    schema: { type: "integer" as const, minimum: 0 },
  },
];

/**
 * Tenant-scoped aggregate search. Mounted at `/api/tenants/:tenantId/search`,
 * behind Interchange's `resolveTenant` (which enforces active membership and
 * populates `tenant`/`principal`), so the handler trusts `c.get("tenant").id`
 * as the authorized scope.
 */
export function createSearchRouter({
  db,
}: {
  db: HubDb;
}): Hono<SearchRouteEnv> {
  const app = new Hono<SearchRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Search"],
      summary: "Aggregate search across workbench sources",
      description:
        "Searches chats, workflows, agents, artifacts, skills, and tools in the active tenant. Per-source limit of 5 with page-based offset; relevance ordered exact > prefix > contains, tie-broken by recency.",
      parameters: QUERY_PARAMS,
      responses: {
        200: {
          description: "Grouped, relevance-ranked palette results",
          content: {
            "application/json": { schema: resolver(SearchResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const queryRaw = c.req.query("q") ?? "";
      const pageParsed = Number(c.req.query("page"));
      const page = Number.isFinite(pageParsed) ? pageParsed : 0;

      try {
        const result = await searchTenant(db, {
          tenantId: tenant.id,
          memberPrincipalId: principal.id,
          query: queryRaw,
          page,
        });
        return c.json(result);
      } catch (err) {
        log.error("Tenant search failed", {
          tenantId: tenant.id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "Search failed" }, 500);
      }
    },
  );

  return app;
}
