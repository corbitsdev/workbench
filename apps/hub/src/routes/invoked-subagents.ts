import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { HubDb } from "../db";
import { listInvokedSubagents } from "../services/invoked-subagents";
import { resolveMyraThreadContext } from "../services/myra-threads";

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
      },
    }),
    async (c) => {
      const userId = c.get("userId" as never) as string | undefined;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);

      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) return c.json({ error: "Forbidden" }, 403);

      const parsed = InvokedSubagentsQuery(c.req.query());
      if (parsed instanceof type.errors) {
        return c.json({ error: parsed.summary }, 400);
      }

      const subagents = await listInvokedSubagents(hubDb, {
        tenantId: ctx.tenantId,
        memberPrincipalId: ctx.memberPrincipalId,
        ...(parsed.originConversationId !== undefined
          ? { originConversationId: parsed.originConversationId }
          : {}),
      });

      return c.json({ subagents });
    },
  );

  return router;
}
