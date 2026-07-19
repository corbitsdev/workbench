import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveNativeRequest,
  listNativeApprovals,
  rejectNativeRequest,
  subscribeApprovals,
} from "../lib/approvals-api";
import type { NativeApproval } from "../lib/approvals-api";
import { instanceIdFromAddress } from "../lib/approval-display";
import { logger } from "../lib/logger";
import { useApprovalDisplayLookups } from "../hooks/use-approval-display-lookups";
import {
  THREAD_TURNS_QUERY_KEY,
  useOpenThreadToolCall,
} from "../hooks/use-thread-tool-calls";
import { NativeApprovalCard } from "./NativeApprovalCard";

export type ReviewGateProps = {
  /** Interchange tenant ID used to scope the native approval decision surface. */
  tenantId: string;
  /**
   * The instance id of the currently-open chat thread, or null on a new/empty
   * chat. The card renders only for approvals raised by THIS instance so an
   * approval never travels chat-to-chat (CL-3940).
   */
  openInstanceId: string | null;
};

type RequestState = "idle" | "approving" | "rejecting";

/**
 * The native (Interchange-suspension) approval decision surface. A suspended
 * tool call has no session linkage, so the list route returns every pending
 * approval the caller owns tenant-wide; the gate then scopes rendering to the
 * open chat by resolving each approval's originating agent address to its
 * instance id and matching it against `openInstanceId` (CL-3940). A new/empty
 * chat (`openInstanceId` null) shows no card.
 */
export function ReviewGate({ tenantId, openInstanceId }: ReviewGateProps) {
  const queryClient = useQueryClient();
  const enabled = tenantId !== "";

  const { data: nativeApprovals = [] } = useQuery({
    queryKey: ["native-approvals", tenantId],
    enabled,
    queryFn: () => listNativeApprovals(tenantId),
  });

  const { lookups } = useApprovalDisplayLookups(tenantId);
  const fallbackToolCall = useOpenThreadToolCall(tenantId, openInstanceId);

  // Only approvals raised by the open thread's instance render here. Resolved
  // from the row's originating agent address so a card never appears in another
  // chat or a new empty one.
  const scopedApprovals = useMemo(() => {
    if (openInstanceId === null) return [];
    return nativeApprovals.filter(
      (approval) =>
        instanceIdFromAddress(approval.agentAddress, lookups) ===
        openInstanceId,
    );
  }, [nativeApprovals, openInstanceId, lookups]);

  // Event-driven refresh (CL-3285): fetch once on mount, then refetch only when
  // the hub pushes an approval change over the shared notifications stream. An
  // idle chat with no pending approvals issues no repeating requests. The event
  // is a change notification, so we always invalidate and let the
  // ownership-scoped list route decide what the caller may see.
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeApprovals(
      tenantId,
      () => {
        void queryClient.invalidateQueries({
          queryKey: ["native-approvals", tenantId],
        });
        // Re-derive the open thread's suspended tool call so the card enriches
        // from the transcript the moment an approval appears (CL-3940).
        void queryClient.invalidateQueries({
          queryKey: [THREAD_TURNS_QUERY_KEY, tenantId],
        });
      },
      // A terminally-failed stream (never opened) would otherwise leave the gate
      // silently stale until the next window-focus refetch. Log it so the drop
      // is at least visible to operators rather than swallowed.
      (error) => {
        logger.warn("Approvals stream connection failed", error.message);
      },
    );
    return unsubscribe;
  }, [enabled, tenantId, queryClient]);

  const [itemStates, setItemStates] = useState<
    Map<string, { requestState: RequestState; error: string | null }>
  >(new Map());

  function getItemState(id: string) {
    return (
      itemStates.get(id) ?? {
        requestState: "idle" as RequestState,
        error: null,
      }
    );
  }

  function patchItemState(
    id: string,
    patch: { requestState?: RequestState; error?: string | null },
  ) {
    setItemStates((prev) => {
      const current = prev.get(id) ?? {
        requestState: "idle" as RequestState,
        error: null,
      };
      const next = new Map(prev);
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  if (scopedApprovals.length === 0) return null;

  async function handleApprove(id: string) {
    patchItemState(id, { requestState: "approving", error: null });
    try {
      await approveNativeRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["native-approvals", tenantId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Approval failed.",
      });
    }
  }

  async function handleReject(id: string) {
    patchItemState(id, { requestState: "rejecting", error: null });
    try {
      await rejectNativeRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["native-approvals", tenantId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Rejection failed.",
      });
    }
  }

  // Newest-first so "what to review first" reads reliably top-to-bottom.
  const queue = [...scopedApprovals].sort(
    (x: NativeApproval, y: NativeApproval) =>
      y.createdAt.localeCompare(x.createdAt),
  );

  return (
    <div className="flex flex-col gap-2" data-testid="review-gate">
      {queue.map((native) => {
        const { requestState, error } = getItemState(native.id);
        return (
          <NativeApprovalCard
            key={native.id}
            approval={native}
            fallbackToolCall={fallbackToolCall}
            requestState={requestState}
            error={error}
            onApprove={() => void handleApprove(native.id)}
            onReject={() => void handleReject(native.id)}
          />
        );
      })}
    </div>
  );
}
