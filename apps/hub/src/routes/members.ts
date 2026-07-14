import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "members"]);

const { principal } = intxSchema;

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover this operation; these schemas document (they do not replace) the
// handler's existing manual validation.
const Member = type({ id: "string", name: "string", refId: "string" });
const MembersResponse = type({ members: Member.array() });
const ErrorResponse = type({ error: "string" });

export function createMembersRouter(
  db: DB["db"],
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get(
    "/members",
    describeRoute({
      tags: ["Members"],
      summary: "List workbench members",
      description:
        "Lists the user members of a tenant. Requires `?tenantId=<id>`; the caller must be a user member of that tenant. Returns each member as `{ id, name, refId }`, where `id` is the user principal id and `refId` is the bare user id — the same id used to build the `usr_<refId>` mention token and mailbox address.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: true,
          description: "Tenant whose members to list.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Tenant members",
          content: {
            "application/json": { schema: resolver(MembersResponse) },
          },
        },
        400: {
          description: "Missing tenantId query parameter",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a member of the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const tenantId = c.req.query("tenantId");

      if (!tenantId) {
        return c.json({ error: "tenantId query parameter required" }, 400);
      }

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });

      if (!callerPrincipal) {
        log.warn("Members list forbidden: caller is not a tenant member", {
          userId,
          tenantId,
        });
        return c.json({ error: "Forbidden" }, 403);
      }

      const userPrincipals = await db.query.principal.findMany({
        where: and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
        ),
      });

      const refIds = userPrincipals.map((p) => p.refId);
      const users =
        refIds.length > 0
          ? await db.query.user.findMany({
              where: (u, { inArray }) => inArray(u.id, refIds),
            })
          : [];

      const userById = new Map(users.map((u) => [u.id, u]));

      const members: { id: string; name: string; refId: string }[] = [];
      for (const p of userPrincipals) {
        const userRow = userById.get(p.refId);
        if (!userRow) {
          log.warn(
            "User principal has no matching user row — data integrity issue",
            {
              principalId: p.id,
              refId: p.refId,
              tenantId,
            },
          );
          continue;
        }
        members.push({ id: p.id, name: userRow.name, refId: p.refId });
      }

      return c.json({ members });
    },
  );

  return router;
}
