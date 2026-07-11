import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { approval } from "../db/schema";
import type { HubDb } from "../db";
import { callerCanResolveApproval } from "../lib/instance-ownership";

const log = getLogger(["api", "approvals"]);

const { principal } = intxSchema;

export const InternalApprovalCreateSchema = type({
  tenantId: "string",
  agentId: "string",
  principalId: "string",
  action: "string",
  resource: "string",
  "sessionId?": "string",
  "context?": "Record<string, unknown>",
});

export const RejectBodySchema = type({ "message?": "string" });

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
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

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

    const rows = await db
      .select()
      .from(approval)
      .where(
        and(eq(approval.tenantId, tenantId), eq(approval.status, "pending")),
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
