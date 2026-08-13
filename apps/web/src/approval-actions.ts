// Builds the `ApprovalActions` port `ChatWorkspace` (`@corbits/chat-ui`)
// calls for its in-chat approve card. Reuses the exact functions Inbox and
// the Activity band already use -- `getApprovalNeedsYou`, `approveApproval`,
// `rejectApproval` in `api.ts` -- and invalidates the same query keys they
// invalidate, so approving in chat updates Inbox's badge and the Activity
// band's count live, and vice versa. This is the one place that logic
// belongs: chat-ui owns no `QueryClient`, so the invalidation the design
// calls for can only run here.

import type { QueryClient } from "@tanstack/react-query";
import type { ApprovalActions } from "@corbits/chat-ui";

import {
  APIMutationError,
  approveApproval,
  getApprovalNeedsYou,
  rejectApproval,
} from "./api";
import { tenantKeys } from "./query-client";

export function createChatApprovalActions(
  tenantId: string,
  queryClient: QueryClient,
): ApprovalActions {
  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.needsYou(tenantId),
    });
    // Mirrors `inbox-page.tsx`'s own `invalidateInbox`: any cached query
    // keyed under this tenant's inbox paths (list, detail, counts).
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (!Array.isArray(key)) return false;
        return key.some(
          (part) =>
            typeof part === "string" &&
            part.includes(`/api/tenants/${tenantId}/inbox`),
        );
      },
    });
  }

  return {
    async getStatus(approvalId) {
      const result = await getApprovalNeedsYou(tenantId, approvalId);
      switch (result.kind) {
        case "ready":
          // A successful read against the tenant-wide `approval:*` grant
          // implies the native per-deployment grant too (the pattern the
          // wider grant is checked against subsumes it) -- pending here is
          // always actionable. See `packages/approvals/src/routes.ts`.
          return {
            kind: "ready",
            status: result.item.status,
            canAct: result.item.status === "pending",
          };
        case "forbidden":
          return { kind: "forbidden" };
        case "not-found":
          return { kind: "not-found" };
        case "error":
          return { kind: "error", message: result.message };
      }
    },
    async approve(approvalId) {
      try {
        const approval = await approveApproval(tenantId, approvalId);
        invalidate();
        return { kind: "resolved", status: approval.status as "approved" };
      } catch (cause) {
        if (cause instanceof APIMutationError && cause.status === 403) {
          return {
            kind: "forbidden",
            message: "You do not have permission to approve this.",
          };
        }
        return {
          kind: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Couldn't approve this request.",
        };
      }
    },
    async reject(approvalId) {
      try {
        const approval = await rejectApproval(tenantId, approvalId);
        invalidate();
        return { kind: "resolved", status: approval.status as "rejected" };
      } catch (cause) {
        if (cause instanceof APIMutationError && cause.status === 403) {
          return {
            kind: "forbidden",
            message: "You do not have permission to deny this.",
          };
        }
        return {
          kind: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Couldn't deny this request.",
        };
      }
    },
  };
}
