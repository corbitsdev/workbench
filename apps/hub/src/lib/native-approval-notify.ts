import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { SidecarLookups } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { ApprovalsEventBus } from "./approvals-events";
import type { NativeApprovalEnricher } from "./native-approval-enrich";

const { workflowDeployment } = intxSchema;

const log = getLogger(["api", "native-approvals", "notify"]);

type RegisterSignalCorrelation = NonNullable<
  SidecarLookups["registerSignalCorrelation"]
>;

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
 * Best-effort: a publish failure is logged, never thrown, so a listener error
 * cannot corrupt the resolve route's already-committed response.
 */
export function publishNativeApprovalResolved(
  bus: ApprovalsEventBus,
  tenantId: string,
): void {
  try {
    bus.publish({ tenantId, sessionId: null, kind: "resolved" });
  } catch (err) {
    log.warn("native approval resolved-notify failed", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Composes interchange's `registerSignalCorrelation` (which owns the native
 * co-write transaction) with the workbench "created" notification. The
 * notification is fired strictly AFTER the co-write commits and is fully
 * isolated: a publish failure (a transient DB read, a listener throw) is caught
 * and logged, never propagated. Without this isolation a thrown publish would
 * surface out of the register call and interchange's pre-existing handler would
 * mis-attribute it as a `signal.correlation.register` failure even though the
 * approval + correlation rows were durably written. Mirrors the persistMail /
 * onUserMailboxRow best-effort pattern: publish can never fail the write path.
 *
 * The optional `enricher` closes the CL-3940 loop: interchange's co-write leaves
 * the approver-facing `toolDefinition`/`toolArguments` null, and the reactor's
 * snapshot (a `custom.approval.requested` inference event, keyed by the same
 * `correlationId`) may arrive before the row exists. Calling `enrichOnCreated`
 * after the co-write commits applies any buffered snapshot; it is best-effort
 * and self-isolating (never throws), so it cannot fail the write path either.
 */
export function withNativeApprovalCreatedNotify(
  db: HubDb,
  bus: ApprovalsEventBus,
  base: RegisterSignalCorrelation,
  enricher?: NativeApprovalEnricher,
): RegisterSignalCorrelation {
  return async (registration) => {
    await base(registration);
    if (enricher !== undefined) {
      await enricher.enrichOnCreated(registration.correlationId);
    }
    try {
      await publishNativeApprovalCreated(db, bus, registration.deploymentId);
    } catch (err) {
      log.warn("native approval created-notify failed", {
        deploymentId: registration.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
