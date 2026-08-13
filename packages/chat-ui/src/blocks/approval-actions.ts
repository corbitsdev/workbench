// The in-chat approve card's one seam to the platform approval it
// references. `@corbits/chat-ui` owns no session and no query cache, so it
// never fetches or mutates approvals itself -- the host (the same app that
// already resolves `tenantId` for `ChatWorkspace`) supplies this port,
// mirroring how `onOpenArtifact`/`onOpenProfile` thread host callbacks
// through the timeline. The host's implementation is expected to call the
// same Interchange-native approve/reject routes Inbox uses and to invalidate
// the same query keys, so the card, Inbox, and the Activity band stay one
// source of truth.

/** The platform's own status vocabulary for an approval (`ApprovalResponse.status`
 * in `vendor/intx/types/src/approvals.ts`) -- never invented here. */
export type ApprovalLiveStatus =
  "pending" | "approved" | "rejected" | "timeout" | "expired";

/**
 * What the host's status read told the card. `canAct` is a fact the host
 * establishes from its own authorization read (e.g. whether the approval
 * showed up in a grant-scoped "needs you" read) -- the card never infers it
 * from the block's own data.
 *
 * `forbidden` is distinct from `canAct: false`: it means the host's *read*
 * itself was refused, so actionability could not be determined at all. The
 * card's honest answer in that case is to show the Approve/Deny buttons and
 * let the real approve/reject call's own authorization decide, surfacing a
 * 403 inline if it also refuses -- never guessing a spectator verdict from
 * a read that was itself refused.
 */
export type ApprovalStatusQuery =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly status: ApprovalLiveStatus;
      readonly canAct: boolean;
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string };

export type ApprovalDecisionResult =
  | { readonly kind: "resolved"; readonly status: "approved" | "rejected" }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export type ApprovalActions = {
  /** The live read behind the card -- the same display-safe status Inbox
   * and the Activity band resolve an approval to, never derived from the
   * message's own `ApproveBlockData`. */
  readonly getStatus: (approvalId: string) => Promise<ApprovalStatusQuery>;
  /** Calls the same native `/approve` route Inbox calls. */
  readonly approve: (approvalId: string) => Promise<ApprovalDecisionResult>;
  /** Calls the same native `/reject` route Inbox calls. */
  readonly reject: (approvalId: string) => Promise<ApprovalDecisionResult>;
};
