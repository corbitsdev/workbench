// Pure state mapping for the approve card: turns the live status read plus
// any in-flight decision into exactly what the view renders. Kept free of
// React so the branch logic (actable vs. spectator vs. resolved vs. the
// forbidden-read branch) is unit-testable without a DOM.

import type {
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  PlatformApprovalDetail,
} from "./approval-actions";

export type DecisionInFlight = "approve" | "reject" | null;

export type ApproveCardView =
  | { readonly kind: "unwired" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "actionable";
      readonly detail: PlatformApprovalDetail;
      readonly deciding: DecisionInFlight;
      readonly error: string | null;
    }
  /** The read succeeded but couldn't establish the viewer may act (or the
   * read never returned a live status at all, e.g. hosts that only carry
   * the fixed disabled framing) -- status and the platform's own detail
   * shown, no buttons. */
  | {
      readonly kind: "spectator";
      readonly status: ApprovalLiveStatus;
      readonly detail: PlatformApprovalDetail;
    }
  /** The read itself was forbidden, so the platform's own detail never
   * arrived. Buttons render anyway: the refusal a person needs to see is
   * the one their own decision earns, surfaced inline from approve/reject,
   * not a disabled card they cannot ask about. There is deliberately no
   * `detail` here: this is the one case where buttons show without it, so
   * the view must never let the block's agent-authored `body`/`title`
   * stand in as if it were that detail. */
  | {
      readonly kind: "undetermined";
      readonly deciding: DecisionInFlight;
      readonly error: string | null;
    }
  | {
      readonly kind: "resolved";
      readonly status: ApprovalLiveStatus;
      readonly detail: PlatformApprovalDetail;
      /** Set when this render followed a decision call that came back
       * `"conflict"` (HTTP 409): the card re-synced and found the approval
       * already resolved by someone/something else, rather than by this
       * click -- worth a calmer, more specific note than the bare status. */
      readonly resolvedElsewhere: boolean;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "load-error"; readonly message: string };

const TERMINAL_STATUSES: readonly ApprovalLiveStatus[] = [
  "approved",
  "rejected",
  "timeout",
  "expired",
];

export function isTerminalStatus(status: ApprovalLiveStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Derives what the card shows. `wired` is false when the host gave no
 * `ApprovalActions` port at all -- the pre-round-trip fallback: static
 * framing, fixed disabled buttons, no fetch ever attempted.
 *
 * `resolvedElsewhere` only ever marks a genuinely resolved render: it has
 * no effect unless `live` is itself `"ready"` with a terminal status, so a
 * stale flag left over from an earlier decision can never fabricate a
 * resolution.
 */
export function deriveApproveCardView(args: {
  readonly wired: boolean;
  readonly live: ApprovalStatusQuery;
  readonly deciding: DecisionInFlight;
  readonly decisionError: string | null;
  readonly resolvedElsewhere?: boolean;
}): ApproveCardView {
  if (!args.wired) return { kind: "unwired" };

  switch (args.live.kind) {
    case "loading":
      return { kind: "loading" };
    case "not-found":
      return { kind: "not-found" };
    case "error":
      return { kind: "load-error", message: args.live.message };
    case "forbidden":
      return {
        kind: "undetermined",
        deciding: args.deciding,
        error: args.decisionError,
      };
    case "ready": {
      if (isTerminalStatus(args.live.status)) {
        return {
          kind: "resolved",
          status: args.live.status,
          detail: args.live.detail,
          resolvedElsewhere: args.resolvedElsewhere ?? false,
        };
      }
      if (!args.live.canAct) {
        return {
          kind: "spectator",
          status: args.live.status,
          detail: args.live.detail,
        };
      }
      return {
        kind: "actionable",
        detail: args.live.detail,
        deciding: args.deciding,
        error: args.decisionError,
      };
    }
  }
}
