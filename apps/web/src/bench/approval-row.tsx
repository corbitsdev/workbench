// One pending approval in the bench drawer's "Needs you" section: who is
// asking, the exact call it is gating, and the approve/deny buttons that
// unpark the run.

import { Button, formatRelativeTime } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiQueryError } from "@/lib/api-query";
import { approveApproval, rejectApproval } from "../api";
import { IdentityAvatar } from "../chat/avatar";
import type { PendingApproval } from "../pending-approvals";
import { tenantKeys } from "../query-client";
import { markApprovalAnswered } from "../worker-status";

// The hub answers 409 when the ask was already resolved or the run that
// raised it has stopped (e.g. a hub restart); either way no retry helps.
const STALE_APPROVAL =
  "This request can't be answered anymore: it was already resolved or its worker stopped.";

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
      markApprovalAnswered(queryClient, tenantId, item.id);
      void queryClient.invalidateQueries({
        queryKey: tenantKeys.pendingApprovals(tenantId),
      });
    },
    onError: (cause, action) => {
      if (cause instanceof ApiQueryError && cause.status === 409) {
        toast(STALE_APPROVAL);
        return;
      }
      toast(
        cause instanceof Error
          ? cause.message
          : `Couldn't ${action === "approve" ? "approve" : "deny"} that request.`,
      );
    },
  });
  const pending = resolveMutation.isPending ? resolveMutation.variables : null;

  return (
    <div className="drawer-approval">
      <div className="drawer-li">
        <IdentityAvatar kind="agent" name={item.agentName} principalId={item.agentAddress} />
        <span className="drawer-li-t">
          <b>{item.headline}</b>
          <span>
            {item.agentName}
            {item.toolName === undefined ? "" : ` · ${item.toolName}`} ·{" "}
            {formatRelativeTime(item.createdAt)}
          </span>
        </span>
      </div>
      {/* Arguments are untrusted agent output: rendered as a plain text node
       * only, never as markup. */}
      {item.argumentsSummary !== undefined ? (
        <code className="drawer-approval-call">{item.argumentsSummary}</code>
      ) : null}
      <div className="workbench-info-row-actions">
        <Button
          variant="ghost"
          size="sm"
          className="btn-danger-ghost"
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
    </div>
  );
}
