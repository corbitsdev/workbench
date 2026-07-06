import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { getActorById, ActorSchema } from "../services/actor-search";

const log = getLogger(["api", "actor-detail"]);

type ActorDetailRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

/**
 * Tenant-scoped single-actor lookup. Mounted at
 * `/api/tenants/:tenantId/actors/:principalId`, behind Interchange's
 * `resolveTenant` (active-membership enforced). Resolves a principal id to its
 * identity so the deep-linkable actor detail page can render from the id alone.
 * The sibling `/actors/search` mount takes precedence for the static `search`
 * segment (static routes rank above dynamic params).
 */
export function createActorDetailRouter({
  db,
}: {
  db: HubDb;
}): Hono<ActorDetailRouteEnv> {
  const app = new Hono<ActorDetailRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Actors"],
      summary:
        "Resolve a single principal (user or agent) in the active tenant",
      description:
        "Returns the actor identity (name, kind, status, email when known) for a principal id within the active tenant, or 404 when no such principal exists in that tenant. Powers the deep-linkable actor detail page.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the lookup.",
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          description: "Principal to resolve.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The resolved actor identity",
          content: { "application/json": { schema: resolver(ActorSchema) } },
        },
        404: { description: "No such principal in this tenant" },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const principalId = c.req.param("principalId");
      if (principalId === undefined || principalId === "") {
        return c.json(
          { error: { code: "bad_request", message: "Missing principalId" } },
          400,
        );
      }

      try {
        const actor = await getActorById(db, {
          tenantId: tenant.id,
          principalId,
        });
        if (actor === null) {
          return c.json(
            { error: { code: "not_found", message: "Actor not found" } },
            404,
          );
        }
        return c.json(actor);
      } catch (err) {
        log.error("Actor lookup failed", {
          tenantId: tenant.id,
          principalId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json(
          { error: { code: "internal_error", message: "Actor lookup failed" } },
          500,
        );
      }
    },
  );

  return app;
}
