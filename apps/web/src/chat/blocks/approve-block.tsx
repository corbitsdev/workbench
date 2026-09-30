// See docs/chat-wire-contract.md for why the platform's own detail is
// authoritative. No `ApprovalActions` port: falls back to pre-round-trip
// framing, fixed disabled buttons, no fetch.

import { Button } from "@corbits/react-ui";
import type { ApproveBlockData } from "../wire/blocks";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CorbitAvatar } from "../avatar";
import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";
import type {
  ApprovalActions,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  PlatformApprovalDetail,
} from "./approval-actions";
import { deriveApproveCardView } from "./approve-card-state";

function statusLabel(status: ApprovalLiveStatus): string {
  switch (status) {
    case "pending":
      return CHAT_STRINGS.blockApproveStatusLoading;
    case "approved":
      return CHAT_STRINGS.blockApproveStatusApproved;
    case "rejected":
      return CHAT_STRINGS.blockApproveStatusRejected;
    case "timeout":
      return CHAT_STRINGS.blockApproveStatusTimeout;
    case "expired":
      return CHAT_STRINGS.blockApproveStatusExpired;
  }
}

type Choice = "once" | "always" | "ask" | "reject";

function resolvedLabel(choice: Choice | null, status: ApprovalLiveStatus): string {
  switch (choice) {
    case "once":
      return CHAT_STRINGS.blockApproveResolvedOnce;
    case "always":
      return CHAT_STRINGS.blockApproveResolvedAlways;
    case "ask":
      return CHAT_STRINGS.blockApproveResolvedAskEvery;
    case "reject":
      return CHAT_STRINGS.blockApproveResolvedDenied;
    case null:
      return statusLabel(status);
  }
}

/** The platform's own account of the request -- always rendered first and
 * unmissable whenever it's available, so a human never decides against
 * only the agent's framing. */
function PlatformDetail({ detail }: { readonly detail: PlatformApprovalDetail }) {
  const args = Object.entries(detail.arguments);
  return (
    <div className="chat-block-approve-platform">
      <div className="chat-block-approve-who">
        <CorbitAvatar ariaLabel={detail.agentName} size="sm" />
        <div>
          <p className="chat-block-approve-platform-requester">
            {CHAT_STRINGS.blockApprovePlatformRequestedBy(detail.agentName)}
          </p>
          <p className="chat-block-approve-platform-headline">{detail.headline}</p>
        </div>
      </div>
      {detail.toolName !== undefined && (
        <p className="chat-block-approve-tool">{detail.toolName}</p>
      )}
      {args.length > 0 && (
        <dl className="chat-block-approve-args">
          {args.map(([label, value]) => (
            <div key={label} className="chat-block-approve-arg">
              <dt>{label}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ApproveButtons({
  deciding,
  onDecide,
}: {
  readonly deciding: Choice | null;
  readonly onDecide: (choice: Choice) => void;
}) {
  const busy = deciding !== null;
  return (
    <div className="chat-block-actions chat-block-approve-choices">
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={() => onDecide("once")}
      >
        {deciding === "once"
          ? CHAT_STRINGS.blockApproveApproving
          : CHAT_STRINGS.blockApproveAllowOnce}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onDecide("always")}
      >
        {CHAT_STRINGS.blockApproveAlways}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onDecide("ask")}
      >
        {CHAT_STRINGS.blockApproveAskEvery}
      </Button>
      <span className="chat-block-approve-sep" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="btn-danger-ghost"
        disabled={busy}
        onClick={() => onDecide("reject")}
      >
        {deciding === "reject" ? CHAT_STRINGS.blockApproveRejecting : CHAT_STRINGS.blockDenyAction}
      </Button>
    </div>
  );
}

export function ApproveBlockView({
  data,
  actions,
}: {
  readonly data: ApproveBlockData;
  readonly actions?: ApprovalActions;
}) {
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);

  const status = useQuery<ApprovalStatusQuery>({
    queryKey: ["approval-status", data.approvalId],
    queryFn: () =>
      actions === undefined
        ? Promise.resolve<ApprovalStatusQuery>({ kind: "loading" })
        : actions.getStatus(data.approvalId),
    enabled: actions !== undefined,
  });
  const live: ApprovalStatusQuery = status.data ?? { kind: "loading" };

  // Never trust a decision response (or a local guess) over the platform's
  // own state — every outcome, success or failure alike, re-reads the
  // status above and renders only what comes back.
  const [choice, setChoice] = useState<Choice | null>(null);
  const decideMutation = useMutation({
    mutationFn: (picked: Choice) => {
      if (actions === undefined) throw new Error("approval actions unavailable");
      switch (picked) {
        case "reject":
          return actions.reject(data.approvalId);
        case "always":
          return actions.allowStanding(data.approvalId);
        case "once":
        case "ask":
          return actions.approve(data.approvalId);
      }
    },
    onSuccess: (result, picked) => {
      if (result.kind === "resolved") {
        setResolvedElsewhere(false);
        setChoice(picked);
      } else if (result.kind === "conflict") {
        // Someone/something else resolved this first. There is nothing to
        // retry -- the refreshed terminal status speaks, with a calmer note
        // than a bare error.
        setResolvedElsewhere(true);
      } else {
        setResolvedElsewhere(false);
        setDecisionError(
          result.kind === "forbidden"
            ? CHAT_STRINGS.blockApproveActionForbidden
            : CHAT_STRINGS.blockApproveActionError,
        );
      }
    },
    onSettled: () => {
      void status.refetch();
    },
  });

  const deciding: Choice | null = decideMutation.isPending ? decideMutation.variables : null;

  function decide(picked: Choice) {
    if (actions === undefined) return;
    setDecisionError(null);
    decideMutation.mutate(picked);
  }

  const view = deriveApproveCardView({
    wired: actions !== undefined,
    live,
    deciding: deciding === null ? null : deciding === "reject" ? "reject" : "approve",
    decisionError,
    resolvedElsewhere,
  });

  const detail =
    view.kind === "actionable" || view.kind === "spectator" || view.kind === "resolved"
      ? view.detail
      : null;

  if (view.kind === "resolved") {
    return (
      <div className="chat-block chat-block-resolved">
        <p className="chat-block-approve-status" data-status={view.status}>
          {resolvedLabel(choice, view.status)}
          {detail?.toolName !== undefined ? ` · ${detail.toolName}` : ""}
        </p>
        {view.resolvedElsewhere && (
          <p className="chat-block-text">{CHAT_STRINGS.blockApproveConflictNote}</p>
        )}
      </div>
    );
  }

  return (
    <BlockCard title={data.title} attention={view.kind === "actionable"}>
      {detail !== null && <PlatformDetail detail={detail} />}
      {detail?.consequence !== undefined && (
        <p className="chat-block-text chat-block-consequence">{detail.consequence}</p>
      )}
      {view.kind !== "undetermined" && data.body !== undefined && (
        <p className="chat-block-text chat-block-agent-note">
          {detail !== null ? `${CHAT_STRINGS.blockApproveAgentNoteLabel}: ` : ""}
          {data.body}
        </p>
      )}
      {view.kind === "unwired" && (
        <div className="chat-block-actions">
          <Button type="button" variant="primary" disabled>
            {CHAT_STRINGS.blockApproveAction}
          </Button>
          <Button type="button" variant="ghost" className="btn-danger-ghost" disabled>
            {CHAT_STRINGS.blockDenyAction}
          </Button>
        </div>
      )}
      {view.kind === "loading" && (
        <p className="chat-block-text chat-block-approve-status">
          {CHAT_STRINGS.blockApproveStatusLoading}
        </p>
      )}
      {view.kind === "not-found" && (
        <p className="chat-block-text chat-block-approve-status">
          {CHAT_STRINGS.blockApproveStatusNotFound}
        </p>
      )}
      {view.kind === "load-error" && (
        <p className="chat-block-text chat-block-approve-status" role="alert">
          {CHAT_STRINGS.blockApproveStatusLoadError}
        </p>
      )}
      {view.kind === "spectator" && (
        <>
          <p className="chat-block-approve-status" data-status={view.status}>
            {statusLabel(view.status)}
          </p>
          <p className="chat-block-text">{CHAT_STRINGS.blockApproveSpectatorNote}</p>
        </>
      )}
      {(view.kind === "actionable" || view.kind === "undetermined") && (
        <>
          {view.kind === "undetermined" && (
            <p className="chat-block-text">{CHAT_STRINGS.blockApproveUndeterminedNote}</p>
          )}
          {view.error !== null && (
            <p className="chat-block-text" role="alert">
              {view.error}
            </p>
          )}
          <ApproveButtons deciding={deciding} onDecide={decide} />
        </>
      )}
    </BlockCard>
  );
}
