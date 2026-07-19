import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveNativeRequest,
  listNativeApprovals,
  rejectNativeRequest,
  subscribeApprovals,
} from "../lib/approvals-api";
import type { NativeApproval } from "../lib/approvals-api";
import { logger } from "../lib/logger";
import { NativeApprovalCard } from "./NativeApprovalCard";

export type ReviewGateProps = {
  /** Interchange tenant ID used to scope the native approval decision surface. */
  tenantId: string;
};

type RequestState = "idle" | "approving" | "rejecting";

/**
 * The native (Interchange-suspension) approval decision surface. The rail is
 * tenant-wide: a suspended tool call has no session linkage, so every pending
 * approval for the tenant surfaces here regardless of which chat is open. The
 * list is ownership-scoped server-side to the caller's own agent instances.
 */
export function ReviewGate({ tenantId }: ReviewGateProps) {
  const queryClient = useQueryClient();
  const enabled = tenantId !== "";

  const { data: nativeApprovals = [] } = useQuery({
    queryKey: ["native-approvals", tenantId],
    enabled,
    queryFn: () => listNativeApprovals(tenantId),
  });

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

  if (nativeApprovals.length === 0) return null;

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
  const queue = [...nativeApprovals].sort(
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
