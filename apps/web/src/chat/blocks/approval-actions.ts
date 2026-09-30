// See docs/chat-wire-contract.md for why this is a host-supplied port.

// Never invented here — mirrors `ApprovalResponse.status`.
export type ApprovalLiveStatus = "pending" | "approved" | "rejected" | "timeout" | "expired";

// The authoritative "what am I approving" — the block's own title/body is
// the agent's framing and never a substitute for it.
export type PlatformApprovalDetail = {
  readonly agentName: string;
  readonly headline: string;
  readonly arguments: Record<string, unknown>;
  /** The action's own imperative verb for the primary button (e.g. "Merge
   * it"). Falls back to the generic "Approve" when the host's read doesn't
   * carry one. */
  readonly actionVerb?: string;
  // Replaces a risk-level badge, which only repeated the agent's own
  // framing back at the human deciding against it.
  readonly consequence?: string;
  /** The tool being called, when the approval's snapshot names it. */
  readonly toolName?: string;
  /** Compact plain-text rendering of the call's arguments. */
  readonly argumentsSummary?: string;
};

// See docs/chat-wire-contract.md for why `forbidden` is distinct from
// `canAct: false`.
export type ApprovalStatusQuery =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly status: ApprovalLiveStatus;
      readonly canAct: boolean;
      readonly detail: PlatformApprovalDetail;
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string };

export type ApprovalDecisionResult =
  | { readonly kind: "resolved"; readonly status: "approved" | "rejected" }
  | { readonly kind: "forbidden"; readonly message: string }
  // HTTP 409, no longer pending: distinct from `error` because the right
  // response is "re-sync and show what happened," never "let it retry."
  | { readonly kind: "conflict"; readonly message: string }
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
  /** Stock `/approve` with scope "always": the tool stops asking for this run. */
  readonly allowStanding: (approvalId: string) => Promise<ApprovalDecisionResult>;
};
