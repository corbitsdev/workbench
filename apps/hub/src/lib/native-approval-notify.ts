import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import type { ApprovalsEventBus } from "./approvals-events";

const { workflowDeployment } = intxSchema;

/**
 * Emits the native rail's "created" change notification (CL-3934). The native
 * `approval` row is co-written inside interchange's `registerSignalCorrelation`,
 * which owns the transaction and is out of scope to modify, so this fires from
 * the workbench wrapper AFTER that co-write commits. The row carries no
 * tenantId to the wrapper, so the tenant is re-read from the deployment (which
 * the base call guarantees exists). A missing deployment is a no-op rather than
 * a throw: the notification is a best-effort refetch hint, never the record.
 */
export async function publishNativeApprovalCreated(
  db: HubDb,
  bus: ApprovalsEventBus,
  deploymentId: string,
): Promise<void> {
  const deployment = await db
    .select({ tenantId: workflowDeployment.tenantId })
    .from(workflowDeployment)
    .where(eq(workflowDeployment.id, deploymentId))
    .limit(1)
    .then((rows) => rows[0]);
  if (deployment === undefined) return;
  bus.publish({
    tenantId: deployment.tenantId,
    sessionId: null,
    kind: "created",
  });
}

/**
 * Emits the native rail's "resolved" change notification after interchange's
 * mounted approve/reject route resolves a suspension. A native approval has no
 * session linkage, so `sessionId` is null and the notification is tenant-wide.
 */
export function publishNativeApprovalResolved(
  bus: ApprovalsEventBus,
  tenantId: string,
): void {
  bus.publish({ tenantId, sessionId: null, kind: "resolved" });
}
