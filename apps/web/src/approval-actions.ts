// Builds the `ApprovalActions` port `ChatWorkspace` (`@corbits/chat-ui`)
// calls for its in-chat approve card. Reuses the exact functions the
// Activity band already uses -- `getApprovalNeedsYou`, `approveApproval`,
// `rejectApproval` in `api.ts` -- and invalidates the same query keys it
// invalidates, so approving in chat updates the Activity band's count
// live, and vice versa. This is the one place that logic belongs: chat-ui
// owns no `QueryClient`, so the invalidation the design calls for can only
// run here.

import type { QueryClient } from "@tanstack/react-query";
import type { ApprovalActions, ApprovalDecisionResult } from "@corbits/chat-ui";
import { CHAT_STRINGS } from "@corbits/chat-ui";
import { ApiQueryError } from "@corbits/api-query";

import { approveApproval, getApprovalNeedsYou, rejectApproval } from "./api";
import type { Approval } from "./api";
import { tenantKeys } from "./query-client";

export function createChatApprovalActions(
  tenantId: string,
  queryClient: QueryClient,
): ApprovalActions {
  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.needsYou(tenantId),
    });
    // Any cached query keyed under this tenant's inbox API paths (list,
    // detail, counts) — the tasks backend still owns these routes even
    // though the Inbox page that used to read them is gone.
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

  /**
   * Both `approveApproval`/`rejectApproval` hit the same native resolve
   * route and fail the same way, so both decisions share this mapping. A
   * 409 (already resolved, run no longer running, or deployment
   * unavailable -- see `vendor/intx/hub-api/src/routes/approvals.ts`) is
   * kept distinct from a generic error: it's never something a retry
   * fixes, only something the card's next status read explains.
   */
  async function resolve(
    call: () => Promise<Approval>,
    status: "approved" | "rejected",
    forbiddenMessage: string,
    genericMessage: string,
  ): Promise<ApprovalDecisionResult> {
    try {
      // The native route only ever returns 200 with the exact terminal
      // status this call asked for -- see `resolveApproval` in
      // `vendor/intx/hub-api/src/routes/approvals.ts` -- so `status` here
      // is not a guess.
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
            detail: {
              agentName: result.item.agentName,
              headline: result.item.headline,
              arguments: result.item.arguments as Record<string, unknown>,
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
