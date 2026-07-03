import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import {
  searchActors,
  ActorSearchQueryTooShortError,
  ActorSearchResponseSchema,
  ACTOR_SEARCH_MIN_QUERY_LENGTH,
  ACTOR_SEARCH_MAX_RESULTS,
} from "../services/actor-search";

const log = getLogger(["api", "actor-search"]);

type ActorSearchRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const ActorSearchQuery = type({
  q: "string",
  "limit?": "string.numeric.parse",
});

const ErrorResponse = type({
  error: { code: "string", message: "string" },
});

/**
 * Tenant-scoped actor (principal) search. Mounted at
 * `/api/tenants/:tenantId/actors/search`, behind Interchange's `resolveTenant`
 * (which enforces active membership and populates `tenant`/`principal`), so
 * the handler trusts `c.get("tenant").id` as the authorized scope.
 */
export function createActorSearchRouter({
  db,
}: {
  db: HubDb;
}): Hono<ActorSearchRouteEnv> {
  const app = new Hono<ActorSearchRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Actors"],
      summary: "Search principals (users and agents) in the active tenant",
      description:
        `Case-insensitive contains-search over user names/emails and agent names in the active tenant. ` +
        `Rate-limit contract: queries shorter than ${ACTOR_SEARCH_MIN_QUERY_LENGTH} characters are rejected with 400, ` +
        `results are capped at ${ACTOR_SEARCH_MAX_RESULTS}, and clients MUST debounce keystrokes (>= 300 ms) before calling — ` +
        `this endpoint is not designed for per-keystroke traffic. Results are tenant-scoped by construction; ` +
        `principals from other tenants never appear.`,
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          description: `Search query (minimum ${ACTOR_SEARCH_MIN_QUERY_LENGTH} characters after trimming).`,
          schema: { type: "string", minLength: ACTOR_SEARCH_MIN_QUERY_LENGTH },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description: `Maximum results to return (clamped to ${ACTOR_SEARCH_MAX_RESULTS}).`,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: ACTOR_SEARCH_MAX_RESULTS,
          },
        },
      ],
      responses: {
        200: {
          description: "Matching principals, relevance ordered",
          content: {
            "application/json": {
              schema: resolver(ActorSearchResponseSchema),
            },
          },
        },
        400: {
          description: "Missing/short query or invalid limit",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const queryInput: { q: string; limit?: string } = {
        q: c.req.query("q") ?? "",
      };
      const limitRaw = c.req.query("limit");
      if (limitRaw !== undefined) queryInput.limit = limitRaw;

      const parsed = ActorSearchQuery(queryInput);
      if (parsed instanceof type.errors) {
        return c.json(
          { error: { code: "bad_request", message: parsed.summary } },
          400,
        );
      }

      try {
        const result = await searchActors(db, {
          tenantId: tenant.id,
          query: parsed.q,
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof ActorSearchQueryTooShortError) {
          return c.json(
            { error: { code: "query_too_short", message: err.message } },
            400,
          );
        }
        log.error("Actor search failed", {
          tenantId: tenant.id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json(
          { error: { code: "internal_error", message: "Actor search failed" } },
          500,
        );
      }
    },
  );

  return app;
}
