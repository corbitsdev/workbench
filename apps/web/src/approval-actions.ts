// chat-ui owns no `QueryClient`, so this is the one place that can
// invalidate the same query keys every approval surface shares.

import type { QueryClient } from "@tanstack/react-query";
import type { ApprovalActions, ApprovalDecisionResult } from "@/chat";
import { CHAT_STRINGS } from "@/chat";
import { ApiQueryError } from "@/lib/api-query";

import { approveApproval, rejectApproval } from "./api";
import type { Approval } from "./api";
import { getApprovalDetail } from "./pending-approvals";
import { tenantKeys } from "./query-client";

export function createChatApprovalActions(
  tenantId: string,
  queryClient: QueryClient,
): ApprovalActions {
  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.pendingApprovals(tenantId),
    });
    // The tasks backend still owns these inbox routes even though the
    // Inbox page that used to read them is gone.
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (!Array.isArray(key)) return false;
        return key.some(
          (part) => typeof part === "string" && part.includes(`/api/tenants/${tenantId}/inbox`),
        );
      },
    });
  }

  // A 409 (already resolved, run no longer running) is kept distinct from
  // a generic error: never something a retry fixes.
  async function resolve(
    call: () => Promise<Approval>,
    status: "approved" | "rejected",
    forbiddenMessage: string,
    genericMessage: string,
  ): Promise<ApprovalDecisionResult> {
    try {
      // The native route only ever returns 200 with the exact terminal
      // status asked for, so `status` here is not a guess.
      await call();
      invalidate();
      return { kind: "resolved", status };
    } catch (cause) {
      if (cause instanceof ApiQueryError) {
        if (cause.status === 403) {
          return { kind: "forbidden", message: forbiddenMessage };
        }
        if (cause.status === 409) {
          return { kind: "conflict", message: cause.message };
        }
      }
      return {
        kind: "error",
        message: cause instanceof Error ? cause.message : genericMessage,
      };
    }
  }

  return {
    async getStatus(approvalId) {
      const result = await getApprovalDetail(tenantId, approvalId);
      switch (result.kind) {
        case "ready":
          // This read is gated on the very grant approve and reject are
          // gated on, so a pending approval that could be read is one this
          // viewer can act on.
          return {
            kind: "ready",
            status: result.item.status,
            canAct: result.item.status === "pending",
            detail: {
              agentName: result.item.agentName,
              headline: result.item.headline,
              arguments: result.item.arguments,
            },
          };
        case "forbidden":
          return { kind: "forbidden" };
        case "not-found":
          return { kind: "not-found" };
        case "error":
          return { kind: "error", message: result.message };
      }
    },
    approve(approvalId) {
      return resolve(
        () => approveApproval(tenantId, approvalId),
        "approved",
        CHAT_STRINGS.blockApproveActionForbidden,
        CHAT_STRINGS.blockApproveActionError,
      );
    },
    reject(approvalId) {
      return resolve(
        () => rejectApproval(tenantId, approvalId),
        "rejected",
        CHAT_STRINGS.blockDenyActionForbidden,
        CHAT_STRINGS.blockDenyActionError,
      );
    },
  };
}
