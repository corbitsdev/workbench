import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";
import { listInvokedSubagents } from "../services/invoked-subagents";

const log = getLogger(["api", "invoked-subagents"]);

const InvokedSubagentItem = type({
  mappingId: "string",
  agentId: "string",
  agentName: "string",
  instanceId: "string",
  instanceAddress: "string",
  sessionId: "string | null",
  sessionStatus: "string | null",
  lastActivityAt: "string",
  firstInvokedAt: "string",
  lastInvokedAt: "string",
  originConversationId: "string | null",
});

const InvokedSubagentsResponse = type({
  subagents: InvokedSubagentItem.array(),
});

const InvokedSubagentsQuery = type({
  "originConversationId?": "string<=256",
});

export function createInvokedSubagentsRouter(hubDb: HubDb): Hono {
  const router = new Hono();

  router.get(
    "/invoked-subagents",
    describeRoute({
      tags: ["Me"],
      summary: "List invoked subagents for the current member",
      description:
        "Returns per-member subagent instances created via invoke_agent (myra-invoked-subagent template). Optional `?originConversationId=` scopes to subagents invoked from that Myra thread (CL-3686).",
      responses: {
        200: {
          description: "Invoked subagents visible to the member",
          content: {
            "application/json": {
              schema: resolver(InvokedSubagentsResponse),
            },
          },
        },
        400: { description: "Invalid query" },
        401: { description: "Not authenticated" },
        403: { description: "Not a member" },
        500: { description: "Failed to load invoked subagents" },
      },
    }),
    async (c) => {
      const userId = c.get("userId" as never) as string | undefined;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);

      try {
        const { context, forbidden } = await getRequestedUserContext(
          hubDb,
          userId,
          c.req.query("tenantId"),
        );
        if (forbidden || !context) return c.json({ error: "Forbidden" }, 403);

        const parsed = InvokedSubagentsQuery(c.req.query());
        if (parsed instanceof type.errors) {
          return c.json({ error: parsed.summary }, 400);
        }

        const subagents = await listInvokedSubagents(hubDb, {
          tenantId: context.tenantId,
          memberPrincipalId: context.principalId,
          ...(parsed.originConversationId !== undefined
            ? { originConversationId: parsed.originConversationId }
            : {}),
        });

        return c.json({ subagents });
      } catch (err) {
        log.error("Failed to load invoked subagents", {
          userId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "Failed to load invoked subagents" }, 500);
      }
    },
  );

  return router;
}
