import { Hono, type Env } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema, parseApprovalRow } from "@intx/db";
import { ApprovalResponse } from "@intx/types";
import type { HubDb } from "../db";

const { approval } = intxSchema;

type NativeApprovalsEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

/**
 * Formats a native `approval` row for the wire, shaped to interchange's own
 * `ApprovalResponse` so the mounted native approve/reject routes and this list
 * route agree on the payload. Timestamps are ISO strings.
 */
function formatNativeApproval(row: typeof approval.$inferSelect) {
  const parsed = parseApprovalRow(row);
  return {
    id: parsed.id,
    tenantId: parsed.tenantId,
    deploymentId: parsed.deploymentId,
    runId: parsed.runId,
    agentAddress: parsed.agentAddress,
    correlationId: parsed.correlationId,
    toolDefinition: parsed.toolDefinition,
    toolArguments: parsed.toolArguments,
    scope: parsed.scope,
    status: parsed.status,
    timeoutAt: parsed.timeoutAt ? parsed.timeoutAt.toISOString() : null,
    resolvedAt: parsed.resolvedAt ? parsed.resolvedAt.toISOString() : null,
    createdAt: parsed.createdAt.toISOString(),
    updatedAt: parsed.updatedAt.toISOString(),
  };
}

/**
 * Lists the tenant's pending native (Interchange-suspension) approvals — the
 * decision surface for the native rail (CL-3934). Interchange ships the
 * approve/reject halves of `createApprovalRoutes` but leaves the list route a
 * 501 stub, and its `ApprovalStore` exposes no list read, so the workbench owns
 * the read side. Mounted at `/api/tenants/:tenantId/approvals/native`, behind
 * Interchange's `resolveTenant` (active-membership enforced, populates
 * `tenant`/`principal`), so the handler trusts `c.get("tenant").id` as the
 * authorized scope and a cross-tenant caller never resolves the tenant.
 *
 * Scope is tenant-membership during the staff-only soak: the enable path is the
 * staff env override / admin grant, and a native row carries no tool arguments
 * yet (the reactor suspend-time co-write leaves `toolDefinition`/`toolArguments`
 * null until the inference-layer plumbing lands upstream), so there is no
 * per-member payload to leak. Per-member ownership narrowing is deferred with
 * that plumbing.
 */
export function createNativeApprovalsRouter({
  db,
}: {
  db: HubDb;
}): Hono<NativeApprovalsEnv> {
  const app = new Hono<NativeApprovalsEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Approvals"],
      summary: "List pending native approvals in the tenant",
      description:
        "Returns the tenant's pending Interchange-suspension approvals (the native rail's decision surface). The workbench owns this read because Interchange's own list route is a 501 stub. Behind resolveTenant; scoped to the authenticated tenant.",
      responses: {
        200: {
          description: "Pending native approvals, newest first",
          content: {
            "application/json": {
              schema: resolver(ApprovalResponse.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const tenantId = c.get("tenant").id;
      const rows = await db
        .select()
        .from(approval)
        .where(
          and(eq(approval.tenantId, tenantId), eq(approval.status, "pending")),
        )
        .orderBy(desc(approval.createdAt));
      return c.json(rows.map(formatNativeApproval));
    },
  );

  return app;
}
