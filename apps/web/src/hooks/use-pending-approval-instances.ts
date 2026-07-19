import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listNativeApprovals, subscribeApprovals } from "../lib/approvals-api";
import { listAgentInstances } from "../lib/hub-api";
import { pendingApprovalInstanceIds } from "../lib/pending-approval-instances";
import { logger } from "../lib/logger";
import { useActiveWorkbench } from "../lib/active-workbench-context";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The set of agent-instance ids in the active workbench that currently have a
 * pending native approval. Consumed by surfaces outside the chat thread (the
 * sidebar chat list, the notification bell) to show a "needs review" indicator
 * without rendering the Approve/Reject card itself.
 *
 * Shares the `native-approvals` query key with the ReviewGate so the two stay
 * consistent, and subscribes to the approvals SSE stream directly — the gate is
 * only mounted inside a chat surface, so the sidebar cannot rely on it to keep
 * the list live. The stream is a change notification; we invalidate on it and
 * let the ownership-scoped list route decide what the caller may see.
 */
export function usePendingApprovalInstances(): ReadonlySet<string> {
  const { activeTenantId } = useActiveWorkbench();
  const tenantId = activeTenantId ?? "";
  const enabled = tenantId !== "";
  const queryClient = useQueryClient();

  const approvalsQuery = useQuery({
    queryKey: ["native-approvals", tenantId],
    enabled,
    queryFn: () => listNativeApprovals(tenantId),
  });

  const instancesQuery = useQuery({
    queryKey: ["approval-display-instances", tenantId],
    enabled,
    queryFn: () => listAgentInstances(tenantId),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeApprovals(
      tenantId,
      () => {
        void queryClient.invalidateQueries({
          queryKey: ["native-approvals", tenantId],
        });
      },
      (error) => {
        logger.warn("Approvals stream connection failed", error.message);
      },
    );
    return unsubscribe;
  }, [enabled, tenantId, queryClient]);

  return useMemo(() => {
    const approvals = approvalsQuery.data;
    const instances = instancesQuery.data;
    if (approvals === undefined || instances === undefined) return EMPTY;
    return pendingApprovalInstanceIds(approvals, instances);
  }, [approvalsQuery.data, instancesQuery.data]);
}
