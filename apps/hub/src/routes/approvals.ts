import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { streamSSE } from "hono/streaming";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { approval } from "../db/schema";
import type { HubDb } from "../db";
import type { ApprovalsEventBus } from "../lib/approvals-events";
import {
  callerCanResolveApproval,
  resolveOwnedApprovalPrincipalIds,
} from "../lib/instance-ownership";

const log = getLogger(["api", "approvals"]);

const { principal } = intxSchema;

// arktype's `Record<string, unknown>` admits arrays (an array is an object), so
// a narrow rejects them explicitly — a tool-call context is always a keyed
// object, never a JSON array.
const ApprovalContextSchema = type("Record<string, unknown>").narrow(
  (value, ctx) =>
    Array.isArray(value) ? ctx.reject("a non-array object") : true,
);

export const InternalApprovalCreateSchema = type({
  tenantId: "string",
  agentId: "string",
  principalId: "string",
  action: "string",
  resource: "string",
  "sessionId?": "string",
  "context?": ApprovalContextSchema,
});

export const RejectBodySchema = type({ "message?": "string" });

const HEARTBEAT_INTERVAL_MS = 25_000;

const ErrorResponse = type({ error: "string" });

// ─── User-facing routes (BetterAuth session) ───────────────────────
// Mounted under /api/v1 with the existing auth middleware.

// Confirms the caller has a user principal in the tenant. Checked before the
// approval is fetched so a non-member cannot probe whether a given approval id
// exists (a 404 vs 403 existence oracle).
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

export function createApprovalsRouter(
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
        "Server-Sent Events stream of workbench-owned approval change notifications (created/resolved) for the caller's tenant. Carries only a change signal (tenantId, optional sessionId, kind) — never approval rows or tool-call arguments; the client refetches the ownership-scoped list route on each event. BetterAuth-authenticated; the caller must be a member of the tenant.",
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

  router.get("/tenants/:tenantId/approvals", async (c) => {
    const userId = c.get("userId");
    const { tenantId } = c.req.param();

    // Verify the calling user belongs to this tenant before returning approvals.
    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, userId),
      ),
    });
    if (!callerPrincipal) return c.json({ error: "Forbidden" }, 403);

    // Scope to approvals the caller owns so one tenant member never sees another
    // member's pending tool-call arguments.
    const ownedPrincipalIds = await resolveOwnedApprovalPrincipalIds(
      db,
      tenantId,
      callerPrincipal.id,
    );
    const rows = await db
      .select()
      .from(approval)
      .where(
        and(
          eq(approval.tenantId, tenantId),
          eq(approval.status, "pending"),
          inArray(approval.principalId, ownedPrincipalIds),
        ),
      );
    return c.json(rows.map(formatApproval));
  });

  router.post("/tenants/:tenantId/approvals/:approvalId/approve", async (c) => {
    const userId = c.get("userId");
    const { tenantId, approvalId } = c.req.param();

    const member = await isTenantMember(db, tenantId, userId);
    if (!member) return c.json({ error: "Forbidden" }, 403);

    const [row] = await db
      .select()
      .from(approval)
      .where(and(eq(approval.id, approvalId), eq(approval.tenantId, tenantId)))
      .limit(1);
    if (!row) return c.json({ error: "Not found" }, 404);

    const canResolve = await callerCanResolveApproval(db, row, userId);
    if (!canResolve) return c.json({ error: "Forbidden" }, 403);

    if (row.status !== "pending")
      return c.json({ error: "Already resolved" }, 409);

    const [updated] = await db
      .update(approval)
      .set({ status: "approved", resolvedAt: new Date() })
      .where(
        and(
          eq(approval.id, approvalId),
          eq(approval.tenantId, tenantId),
          eq(approval.status, "pending"),
        ),
      )
      .returning();
    if (!updated) return c.json({ error: "Already resolved" }, 409);

    bus.publish({
      tenantId,
      sessionId: updated.sessionId ?? null,
      kind: "resolved",
    });

    log.info("Approval approved", { approvalId, tenantId });
    return c.json(formatApproval(updated));
  });

  router.post("/tenants/:tenantId/approvals/:approvalId/reject", async (c) => {
    const userId = c.get("userId");
    const { tenantId, approvalId } = c.req.param();

    // The reject body is optional — an empty body is a valid no-message reject,
    // so it is parsed leniently. Non-empty content must still be valid JSON of
    // the expected shape rather than being silently dropped.
    const rawText = await c.req.text();
    let rawBody: unknown = {};
    if (rawText.trim() !== "") {
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
    }
    const body = RejectBodySchema(rawBody);
    if (body instanceof type.errors) {
      return c.json({ error: body.summary }, 400);
    }

    const member = await isTenantMember(db, tenantId, userId);
    if (!member) return c.json({ error: "Forbidden" }, 403);

    const [row] = await db
      .select()
      .from(approval)
      .where(and(eq(approval.id, approvalId), eq(approval.tenantId, tenantId)))
      .limit(1);
    if (!row) return c.json({ error: "Not found" }, 404);

    const canResolve = await callerCanResolveApproval(db, row, userId);
    if (!canResolve) return c.json({ error: "Forbidden" }, 403);

    if (row.status !== "pending")
      return c.json({ error: "Already resolved" }, 409);

    const [updated] = await db
      .update(approval)
      .set({
        status: "rejected",
        message: body.message ?? null,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(approval.id, approvalId),
          eq(approval.tenantId, tenantId),
          eq(approval.status, "pending"),
        ),
      )
      .returning();
    if (!updated) return c.json({ error: "Already resolved" }, 409);

    bus.publish({
      tenantId,
      sessionId: updated.sessionId ?? null,
      kind: "resolved",
    });

    log.info("Approval rejected", { approvalId, tenantId });
    return c.json(formatApproval(updated));
  });

  return router;
}

// ─── Internal routes (sidecar Bearer token) ────────────────────────
// Mounted under /api/internal — does NOT go through BetterAuth middleware.

export function createInternalApprovalsRouter(
  db: DB["db"],
  sidecarToken: string,
  bus: ApprovalsEventBus,
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    if (auth !== `Bearer ${sidecarToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  router.post("/approvals", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const validated = InternalApprovalCreateSchema(body);
    if (validated instanceof type.errors) {
      return c.json({ error: validated.summary }, 400);
    }

    const [row] = await db
      .insert(approval)
      .values({
        tenantId: validated.tenantId,
        principalId: validated.principalId,
        agentId: validated.agentId,
        resource: validated.resource,
        action: validated.action,
        sessionId: validated.sessionId,
        context: validated.context,
      })
      .returning();

    bus.publish({
      tenantId: validated.tenantId,
      sessionId: row!.sessionId ?? null,
      kind: "created",
    });

    log.info("Approval created", {
      id: row!.id,
      tenantId: validated.tenantId,
      agentId: validated.agentId,
    });
    return c.json(formatApproval(row!), 201);
  });

  router.get("/approvals/:id", async (c) => {
    const { id } = c.req.param();
    const tenantId = c.req.query("tenantId");
    if (!tenantId)
      return c.json({ error: "tenantId query param required" }, 400);

    const [row] = await db
      .select()
      .from(approval)
      .where(and(eq(approval.id, id), eq(approval.tenantId, tenantId)))
      .limit(1);

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(formatApproval(row));
  });

  return router;
}

function formatApproval(row: typeof approval.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    principalId: row.principalId,
    agentId: row.agentId,
    sessionId: row.sessionId ?? null,
    resource: row.resource,
    action: row.action,
    context: row.context ?? null,
    status: row.status,
    message: row.message ?? null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
