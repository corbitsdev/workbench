// One pending approval with its approve/deny buttons. Shared by the
// workbench workbench's info column and the chat transcript, so a person can
// answer an agent's ask wherever they are looking when it lands.

import { Button, formatRelativeTime, toast } from "@corbits/react-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { approveApproval, rejectApproval } from "../api";
import type { PendingApproval } from "../pending-approvals";
import { tenantKeys } from "../query-client";

export function ApprovalRow({
  item,
  tenantId,
}: {
  readonly item: PendingApproval;
  readonly tenantId: string;
}) {
  const queryClient = useQueryClient();
  const resolveMutation = useMutation({
    mutationFn: (action: "approve" | "deny") =>
      action === "approve" ? approveApproval(tenantId, item.id) : rejectApproval(tenantId, item.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: tenantKeys.pendingApprovals(tenantId),
      });
    },
    onError: (cause, action) => {
      toast(
        cause instanceof Error
          ? cause.message
          : `Couldn't ${action === "approve" ? "approve" : "deny"} that request.`,
      );
    },
  });
  const pending = resolveMutation.isPending ? resolveMutation.variables : null;

  return (
    <li className="workbench-info-approval-row">
      <div>
        <span className="workbench-info-cell-primary">{item.headline}</span>
        <br />
        <span className="workbench-info-cell-context">
          {item.agentName} · {formatRelativeTime(item.createdAt)}
        </span>
      </div>
      <div className="workbench-info-row-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          onClick={() => resolveMutation.mutate("deny")}
        >
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={pending !== null}
          onClick={() => resolveMutation.mutate("approve")}
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </Button>
      </div>
    </li>
  );
}
