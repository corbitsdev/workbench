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
 * A standing-consent offer the platform is willing to take for this
 * approval's tool/resource pair -- present only when the host's read can
 * name both (see `ApproveAction.scope` and its `hub-api` handler, which
 * today rejects `scope: "always"` with `unsupported_scope` because the
 * suspend path doesn't yet capture tool identity). Absence of this field
 * means "not offerable here," never "offerable but hidden."
 */
export type StandingConsentOffer = {
  readonly verb: string;
  readonly resource: string;
};

/**
 * The platform's own account of what is being asked -- who, what tool, with
 * which arguments. This is the authoritative "what am I approving" a human
 * decides against; the block's own `title`/`body` is the *agent's* framing
 * and is never a substitute for it (a confused-deputy card that shows only
 * agent-authored text next to live buttons is exactly the failure mode this
 * type exists to close off).
 */
export type PlatformApprovalDetail = {
  readonly agentName: string;
  readonly headline: string;
  readonly arguments: Record<string, unknown>;
  /** The action's own imperative verb for the primary button (e.g. "Merge
   * it"). Falls back to the generic "Approve" when the host's read doesn't
   * carry one. */
  readonly actionVerb?: string;
  /** One-line, platform-authored consequence of taking the action (e.g.
   * "Merging goes further than posting a review -- it puts the change
   * live."). Replaces a risk-level badge, which only ever repeated the
   * agent's own framing back at the human deciding against it. */
  readonly consequence?: string;
  readonly standingConsent?: StandingConsentOffer;
};

/**
 * What the host's status read told the card. `canAct` is a fact the host
 * establishes from its own authorization read (e.g. whether the approval
 * showed up in a grant-scoped "needs you" read) -- the card never infers it
 * from the block's own data. A `"ready"` result always carries `detail`:
 * there is no code path where a card may show live buttons without the
 * platform's own description of the request alongside them.
 *
 * `forbidden` is distinct from `canAct: false`: it means the host's *read*
 * itself was refused, so actionability -- and the platform detail -- could
 * not be determined at all. The card's honest answer in that case is to
 * show the Approve/Deny buttons (never the agent's framing standing in for
 * a description) and let the real approve/reject call's own authorization
 * decide, surfacing a 403 inline if it also refuses -- never guessing a
 * spectator verdict, and never rendering unverified agent text as if it
 * were the platform's account of the request.
 */
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
  /** The approval was no longer pending by the time this decision reached
   * the platform (HTTP 409: already resolved, run no longer running, or
   * deployment unavailable) -- distinct from a transient `error` because
   * the right response is never "let the user retry," it's "re-sync and
   * show what actually happened." */
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
  /**
   * Turns this one decision into a standing grant for the same tool/resource
   * pair. Optional: the native route this would call (`POST .../approve`
   * with `scope: "always"`) is defined in `@intx/types` but `hub-api`
   * rejects it today (`unsupported_scope` -- the suspend path doesn't yet
   * capture tool identity). Omit this until a host can wire it to something
   * real; the card never shows the standing-consent link without it.
   */
  readonly allowStanding?: (
    approvalId: string,
  ) => Promise<ApprovalDecisionResult>;
};
