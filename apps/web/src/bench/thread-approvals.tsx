// The asks this workbench's live worker is parked on, rendered in the thread
// where the decision happens. An ask whose run is gone stays listed in the
// drawer, but never here: it can no longer be answered.

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { ApproveBlockView } from "@/chat/blocks/approve-block";
import { CHAT_STRINGS } from "@/chat/strings";
import { sameAddress } from "@/chat/threads-api";
import { TenantApprovalsSchema, useAPIQuery } from "../api";
import { createChatApprovalActions } from "../approval-actions";
import { pendingApprovalsPath } from "../pending-approvals";

export function ThreadApprovals({
  workbenchTenantId,
  agentAddresses,
}: {
  readonly workbenchTenantId: string;
  /** Live run addresses of this workbench's agents. */
  readonly agentAddresses: readonly string[];
}) {
  const queryClient = useQueryClient();
  const actions = useMemo(
    () => createChatApprovalActions(workbenchTenantId, queryClient),
    [workbenchTenantId, queryClient],
  );
  const approvals = useAPIQuery(pendingApprovalsPath(workbenchTenantId), TenantApprovalsSchema);
  if (approvals.kind !== "ready") return null;

  const asks = approvals.data.data.filter(
    (row) =>
      row.status === "pending" &&
      agentAddresses.some((address) => sameAddress(address, row.agentAddress)),
  );
  return asks.map((row) => (
    <ApproveBlockView
      key={row.id}
      data={{ approvalId: row.id, title: CHAT_STRINGS.blockApproveNeedsYouTitle }}
      actions={actions}
    />
  ));
}
