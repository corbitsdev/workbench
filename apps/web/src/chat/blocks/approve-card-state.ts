// Kept free of React so the branch logic is unit-testable without a DOM.

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
  // Read succeeded but couldn't establish the viewer may act: status and
  // detail shown, no buttons.
  | {
      readonly kind: "spectator";
      readonly status: ApprovalLiveStatus;
      readonly detail: PlatformApprovalDetail;
    }
  // Read was forbidden; buttons render anyway so the refusal a person
  // needs to see is the one their own decision earns. No `detail`: the
  // view must never substitute the agent-authored body/title for it.
  | {
      readonly kind: "undetermined";
      readonly deciding: DecisionInFlight;
      readonly error: string | null;
    }
  | {
      readonly kind: "resolved";
      readonly status: ApprovalLiveStatus;
      readonly detail: PlatformApprovalDetail;
      // Set on an HTTP 409 conflict: resolved by someone/something else,
      // not this click.
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

// `resolvedElsewhere` has no effect unless `live` is already `"ready"`
// with a terminal status, so a stale flag can never fabricate a
// resolution.
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
