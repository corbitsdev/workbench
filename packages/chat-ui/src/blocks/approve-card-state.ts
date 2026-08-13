// Pure state mapping for the approve card: turns the live status read plus
// any in-flight decision into exactly what the view renders. Kept free of
// React so the branch logic (actable vs. spectator vs. resolved vs. the
// undeterminable-403 fallback) is unit-testable without a DOM.

import type {
  ApprovalLiveStatus,
  ApprovalStatusQuery,
} from "./approval-actions";

export type DecisionInFlight = "approve" | "reject" | null;

export type ApproveCardView =
  | { readonly kind: "unwired" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "actionable";
      readonly deciding: DecisionInFlight;
      readonly error: string | null;
    }
  /** The read succeeded but couldn't establish the viewer may act (or the
   * read never returned a live status at all, e.g. hosts that only carry
   * the fixed disabled framing) -- status shown, no buttons. */
  | { readonly kind: "spectator"; readonly status: ApprovalLiveStatus }
  /** The read itself was forbidden: actionability could not be determined.
   * Buttons render anyway; a real 403 from approve/reject surfaces inline
   * instead of being guessed in advance. */
  | {
      readonly kind: "undetermined";
      readonly deciding: DecisionInFlight;
      readonly error: string | null;
    }
  | { readonly kind: "resolved"; readonly status: ApprovalLiveStatus }
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
 */
export function deriveApproveCardView(args: {
  readonly wired: boolean;
  readonly live: ApprovalStatusQuery;
  readonly deciding: DecisionInFlight;
  readonly decisionError: string | null;
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
        return { kind: "resolved", status: args.live.status };
      }
      if (!args.live.canAct) {
        return { kind: "spectator", status: args.live.status };
      }
      return {
        kind: "actionable",
        deciding: args.deciding,
        error: args.decisionError,
      };
    }
  }
}
