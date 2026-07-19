import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { describeRoute, resolver } from "hono-openapi";
import { streamSSE } from "hono/streaming";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import type { HubDb } from "../db";
import type { ApprovalsEventBus } from "../lib/approvals-events";

const log = getLogger(["api", "approvals"]);

const { principal } = intxSchema;

const HEARTBEAT_INTERVAL_MS = 25_000;

const ErrorResponse = type({ error: "string" });

// Confirms the caller has a user principal in the tenant before opening the
// stream, so a non-member cannot subscribe to another tenant's change signal.
async function isTenantMember(
  db: HubDb,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const member = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, tenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userId),
    ),
  });
  return member !== undefined;
}

/**
 * The approval change-notification stream (SSE). Carries only a change signal
 * (tenantId, optional sessionId, kind) over the shared approvals event bus —
 * never approval rows or tool-call arguments. Each client refetches the
 * ownership-scoped native approvals list on every event. The native rail
 * (`native-approval-notify`) publishes its created/resolved signals onto the
 * same bus, so this is the browser delivery pipe for the native decision
 * surface. Mounted under /api/v1 with the BetterAuth session middleware.
 */
export function createApprovalNotificationsRouter(
  db: HubDb,
  bus: ApprovalsEventBus,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get(
    "/tenants/:tenantId/approvals/stream",
    describeRoute({
      tags: ["Approvals"],
      summary: "Stream approval lifecycle change notifications",
      description:
        "Server-Sent Events stream of approval change notifications (created/resolved) for the caller's tenant. Carries only a change signal (tenantId, optional sessionId, kind) — never approval rows or tool-call arguments; the client refetches the ownership-scoped native list route on each event. BetterAuth-authenticated; the caller must be a member of the tenant.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant id whose approval changes to stream.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description:
            "Server-Sent Events stream of approval change notifications",
          content: { "text/event-stream": {} },
        },
        403: {
          description: "Caller is not a member of the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { tenantId } = c.req.param();

      const member = await isTenantMember(db, tenantId, userId);
      if (!member) return c.json({ error: "Forbidden" }, 403);

      return streamSSE(c, async (stream) => {
        // The notification is tenant-broadcast: every member of the tenant with
        // an open stream receives every created/resolved signal, including one
        // for an approval they do not own. That is safe by design — the frame
        // carries no approval rows or tool-call arguments, only a change signal,
        // and each client reacts by refetching the ownership-scoped list route,
        // which re-gates what that caller may actually see.
        const unsubscribe = bus.subscribe(tenantId, (event) => {
          void stream.writeSSE({
            event: "approvals",
            data: JSON.stringify(event),
          });
        });

        stream.onAbort(() => unsubscribe());

        try {
          // Keep the connection warm through idle-proxy timeouts (Railway). A
          // real SSE comment frame (`: ...`) is never dispatched to any
          // EventSource listener but still resets the proxy idle clock.
          while (!stream.aborted) {
            await stream.sleep(HEARTBEAT_INTERVAL_MS);
            if (stream.aborted) break;
            await stream.write(": heartbeat\n\n");
          }
        } catch (err) {
          log.warn("approvals stream ended", {
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          unsubscribe();
        }
      });
    },
  );

  return router;
}
