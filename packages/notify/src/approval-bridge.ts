// The step the platform is missing: an approval exists, therefore somebody
// has mail. The approval and its signal correlation are already written by
// the platform's own register co-write; this reads that pair back and
// delivers it, registering nothing and widening nothing.
//
// Delivery keys off `approval.id`, which is also the mailbox dedupe key, so a
// redelivered register frame — sidecar reconnect, log replay, supervisor
// restart — mails once and only once.
import { deliverApprovalMail, type NotifyDeliveryDeps } from "./deliver";
import type { NotifyRecipient } from "./events";

export interface ParkedApproval {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly deploymentId: string;
  /** The tool the run is asking to call, named the way a person would read it. */
  readonly toolName: string;
  readonly toolArguments: object;
  readonly createdAt: Date;
}

export interface ApprovalNotificationBridgeDeps {
  readonly delivery: NotifyDeliveryDeps;
  readonly findParkedApproval: (
    correlationId: string,
  ) => Promise<ParkedApproval | null>;
  /** Who may resolve this approval, and therefore who should hear about it. */
  readonly listApprovers: (
    approval: ParkedApproval,
  ) => Promise<readonly NotifyRecipient[]>;
}

export type ApprovalNotificationBridge = (
  correlationId: string,
) => Promise<void>;

/**
 * Build the "an approval was created, so mail it" step. A correlation with no
 * approval row, or an approval nobody can resolve, delivers nothing rather
 * than mailing into the void.
 */
export function createApprovalNotificationBridge(
  deps: ApprovalNotificationBridgeDeps,
): ApprovalNotificationBridge {
  return async (correlationId) => {
    const approval = await deps.findParkedApproval(correlationId);
    if (approval === null) return;
    const recipients = await deps.listApprovers(approval);
    if (recipients.length === 0) return;
    await deliverApprovalMail(deps.delivery, {
      kind: "approval",
      approvalId: approval.approvalId,
      tenantId: approval.tenantId,
      runId: approval.runId,
      deploymentId: approval.deploymentId,
      toolName: approval.toolName,
      toolArguments: approval.toolArguments,
      recipients: [...recipients],
      createdAt: approval.createdAt.toISOString(),
    });
  };
}
