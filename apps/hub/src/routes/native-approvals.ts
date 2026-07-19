import { Hono, type Env } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema, parseApprovalRow } from "@intx/db";
import { ApprovalResponse } from "@intx/types";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

const { approval, agentInstance } = intxSchema;

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
 * The mailbox addresses of the agent instances the caller owns in this tenant.
 * A native `approval` names its originating agent by `agentAddress`, which for a
 * single-agent deploy (Myra/Oat) is that instance's real mailbox address — the
 * same address `member_agent_instance` links the owning member to. Scoping the
 * list to these addresses is the metadata boundary: one member never sees
 * another member's pending agent address / runId / deploymentId / timing.
 */
async function ownedInstanceAddresses(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<string[]> {
  const rows = await db
    .select({ address: agentInstance.address })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      eq(memberAgentInstance.instanceId, agentInstance.id),
    )
    .where(
      and(
        eq(memberAgentInstance.memberPrincipalId, memberPrincipalId),
        eq(agentInstance.tenantId, tenantId),
      ),
    );
  return rows.map((r) => r.address);
}

/**
 * Lists the caller's pending native (Interchange-suspension) approvals — the
 * decision surface for the native rail (CL-3934). Interchange ships the
 * approve/reject halves of `createApprovalRoutes` but leaves the list route a
 * 501 stub, and its `ApprovalStore` exposes no list read, so the workbench owns
 * the read side. Mounted at `/api/tenants/:tenantId/native-approvals`, behind
 * Interchange's `resolveTenant` (active-membership enforced, populates
 * `tenant`/`principal`), so the handler trusts `c.get("tenant").id` /
 * `c.get("principal").id` as the authorized scope and a cross-tenant caller
 * never resolves the tenant.
 *
 * The list is ownership-scoped to the caller's own agent instances (via
 * `member_agent_instance`), so one tenant member never sees another member's
 * pending approval metadata. There is additionally no tool-argument leak: the
 * reactor's suspend-time co-write leaves `toolDefinition`/`toolArguments` null
 * during the soak until the upstream arg-capture plumbing lands.
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
      summary: "List the caller's pending native approvals in the tenant",
      description:
        "Returns the caller's pending Interchange-suspension approvals (the native rail's decision surface), scoped to the agent instances the caller owns. The workbench owns this read because Interchange's own list route is a 501 stub. Behind resolveTenant.",
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
      const memberPrincipalId = c.get("principal").id;
      const addresses = await ownedInstanceAddresses(
        db,
        tenantId,
        memberPrincipalId,
      );
      if (addresses.length === 0) return c.json([]);
      const rows = await db
        .select()
        .from(approval)
        .where(
          and(
            eq(approval.tenantId, tenantId),
            eq(approval.status, "pending"),
            inArray(approval.agentAddress, addresses),
          ),
        )
        .orderBy(desc(approval.createdAt));
      return c.json(rows.map(formatNativeApproval));
    },
  );

  return app;
}
