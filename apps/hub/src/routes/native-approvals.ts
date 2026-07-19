import { Hono, type Env } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { schema as intxSchema, parseApprovalRow, type DB } from "@intx/db";
import { ApprovalResponse } from "@intx/types";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";
import {
  deleteAutoApprovedTool,
  listAutoApprovedToolsForMember,
  persistAutoApprovedTool,
} from "../lib/auto-approved-tools";
import { refreshInstanceGrantsFromDefinition } from "../services/grant-reconcile";

const { approval, agentInstance } = intxSchema;
const log = getLogger(["api", "native-approvals", "auto-approve"]);

/** Request body for durably auto-approving a tool from an approval card. */
export const AutoApproveToolRequest = type({
  approvalId: "string > 0",
  toolName: "string > 0",
});

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

  app.post(
    "/auto-approve",
    describeRoute({
      tags: ["Approvals"],
      summary: "Durably auto-approve a tool for the caller",
      description:
        "Records the member's 'Auto Approve Always' decision for one tool on the agent instance whose call the given approval gated, so the tool's grant re-mints `allow` (no longer suspends). Does not itself resolve the pending approval — the client pairs this with the native approve route to release the current call. The approvalId must name a pending approval the caller owns; a mismatch is masked as not-found so it can never whitelist a tool against an approval the caller does not own.",
      responses: {
        200: {
          description: "Tool durably auto-approved",
          content: {
            "application/json": {
              schema: resolver(type({ ok: "true", toolName: "string" })),
            },
          },
        },
        404: {
          description: "No matching pending approval owned by the caller",
        },
      },
    }),
    validator("json", AutoApproveToolRequest),
    async (c) => {
      const tenantId = c.get("tenant").id;
      const memberPrincipalId = c.get("principal").id;
      const { approvalId, toolName } = c.req.valid("json");

      const approvalRow = await db.query.approval.findFirst({
        where: and(
          eq(approval.id, approvalId),
          eq(approval.tenantId, tenantId),
          eq(approval.status, "pending"),
        ),
      });
      if (!approvalRow) return c.json({ error: "not_found" }, 404);

      const owned = await ownedInstanceAddresses(
        db,
        tenantId,
        memberPrincipalId,
      );
      if (!owned.includes(approvalRow.agentAddress)) {
        return c.json({ error: "not_found" }, 404);
      }

      const instance = await db.query.agentInstance.findFirst({
        where: and(
          eq(agentInstance.tenantId, tenantId),
          eq(agentInstance.address, approvalRow.agentAddress),
        ),
      });
      if (!instance) return c.json({ error: "not_found" }, 404);

      await persistAutoApprovedTool(db, {
        tenantId,
        principalId: instance.principalId,
        toolName,
        createdByPrincipalId: memberPrincipalId,
      });

      // Re-mint the instance's grants now so the tool flips from `ask` to
      // `allow` on the next sidecar reconnect rather than only on the next
      // provisioning launch (the running session keeps its deploy-time grant).
      await refreshInstanceGrantsFromDefinition(db as unknown as DB["db"], {
        agentId: instance.agentId,
        tenantId,
        principalId: instance.principalId,
        address: instance.address,
        instanceId: instance.id,
      });

      log.info("Auto-approved tool for member", {
        tenantId,
        memberPrincipalId,
        instancePrincipalId: instance.principalId,
        toolName,
      });

      return c.json({ ok: true, toolName }, 200);
    },
  );

  app.get(
    "/auto-approved-tools",
    describeRoute({
      tags: ["Approvals"],
      summary: "List the caller's durable auto-approved tools",
      description:
        "Returns the tools the caller has durably auto-approved (their own trust decisions), newest first, so they can be reviewed and revoked.",
      responses: {
        200: {
          description: "The caller's auto-approved tools",
        },
      },
    }),
    async (c) => {
      const tenantId = c.get("tenant").id;
      const memberPrincipalId = c.get("principal").id;
      const rows = await listAutoApprovedToolsForMember(
        db,
        tenantId,
        memberPrincipalId,
      );
      return c.json(rows);
    },
  );

  app.delete(
    "/auto-approved-tools/:id",
    describeRoute({
      tags: ["Approvals"],
      summary: "Revoke a durable auto-approved tool",
      description:
        "Deletes one of the caller's auto-approve decisions and re-mints the affected instance's grants so the tool reverts to requiring approval (`ask`). Scoped to the caller's own records.",
      responses: {
        200: { description: "Revoked" },
        404: { description: "No matching record owned by the caller" },
      },
    }),
    async (c) => {
      const tenantId = c.get("tenant").id;
      const memberPrincipalId = c.get("principal").id;
      const id = c.req.param("id");

      const removed = await deleteAutoApprovedTool(db, {
        tenantId,
        id,
        memberPrincipalId,
      });
      if (!removed) return c.json({ error: "not_found" }, 404);

      // Re-mint every instance the caller owns that runs on the affected
      // principal so the tool returns to `ask`. In the single-agent model the
      // principal maps to one instance; resolve and refresh it.
      const instance = await db.query.agentInstance.findFirst({
        where: and(
          eq(agentInstance.tenantId, tenantId),
          eq(agentInstance.principalId, removed.principalId),
        ),
      });
      if (instance) {
        await refreshInstanceGrantsFromDefinition(db as unknown as DB["db"], {
          agentId: instance.agentId,
          tenantId,
          principalId: instance.principalId,
          address: instance.address,
          instanceId: instance.id,
        });
      }

      log.info("Revoked auto-approved tool for member", {
        tenantId,
        memberPrincipalId,
        instancePrincipalId: removed.principalId,
        toolName: removed.toolName,
      });

      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
