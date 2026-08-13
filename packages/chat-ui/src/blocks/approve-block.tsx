// The approve card renders the agent's framing (title/risk/body) plus the
// live state of the platform approval its `approvalId` references -- the
// same approval Inbox and the Activity band show. Nothing here is a
// decision: resolved state is always re-rendered from the host's status
// read, never from the block's own data (see `ApproveBlockData` -- it
// deliberately carries no status field). When the host gives no
// `ApprovalActions` port, the card falls back to its pre-round-trip framing:
// fixed disabled buttons, no fetch.

import { toast } from "@corbits/react-ui";
import type { ApproveBlockData } from "@corbits/chat/blocks";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "../strings";
import { BlockCard, RiskBadge } from "./block-card";
import type {
  ApprovalActions,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
} from "./approval-actions";
import type { DecisionInFlight } from "./approve-card-state";
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

function ApproveButtons({
  deciding,
  onApprove,
  onDeny,
}: {
  readonly deciding: DecisionInFlight;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}) {
  const busy = deciding !== null;
  return (
    <div className="chat-block-actions">
      <button
        type="button"
        className="chat-block-action"
        data-primary="true"
        disabled={busy}
        onClick={onApprove}
      >
        {deciding === "approve"
          ? CHAT_STRINGS.blockApproveApproving
          : CHAT_STRINGS.blockApproveAction}
      </button>
      <button
        type="button"
        className="chat-block-action"
        disabled={busy}
        onClick={onDeny}
      >
        {deciding === "reject"
          ? CHAT_STRINGS.blockApproveRejecting
          : CHAT_STRINGS.blockDenyAction}
      </button>
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
  const [live, setLive] = useState<ApprovalStatusQuery>({ kind: "loading" });
  const [deciding, setDeciding] = useState<DecisionInFlight>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    if (actions === undefined) return;
    let cancelled = false;
    setLive({ kind: "loading" });
    actions.getStatus(data.approvalId).then((result) => {
      if (!cancelled) setLive(result);
    });
    return () => {
      cancelled = true;
    };
  }, [actions, data.approvalId]);

  function decide(kind: "approve" | "reject") {
    if (actions === undefined) return;
    setDeciding(kind);
    setDecisionError(null);
    const call = kind === "approve" ? actions.approve : actions.reject;
    call(data.approvalId)
      .then((result) => {
        if (result.kind === "resolved") {
          setLive({ kind: "ready", status: result.status, canAct: false });
          toast.success(
            kind === "approve"
              ? CHAT_STRINGS.blockApproveStatusApproved
              : CHAT_STRINGS.blockApproveStatusRejected,
          );
          return;
        }
        setDecisionError(
          result.kind === "forbidden"
            ? CHAT_STRINGS.blockApproveActionForbidden
            : CHAT_STRINGS.blockApproveActionError,
        );
      })
      .finally(() => setDeciding(null));
  }

  const view = deriveApproveCardView({
    wired: actions !== undefined,
    live,
    deciding,
    decisionError,
  });

  return (
    <BlockCard title={data.title}>
      {data.risk !== undefined && (
        <RiskBadge
          level={data.risk}
          label={CHAT_STRINGS.blockRiskLabel(data.risk)}
          note={data.riskNote}
        />
      )}
      {data.body !== undefined && (
        <p className="chat-block-text">{data.body}</p>
      )}
      {view.kind === "unwired" && (
        <div className="chat-block-actions">
          <button
            type="button"
            className="chat-block-action"
            data-primary="true"
            disabled
          >
            {CHAT_STRINGS.blockApproveAction}
          </button>
          <button type="button" className="chat-block-action" disabled>
            {CHAT_STRINGS.blockDenyAction}
          </button>
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
          <p className="chat-block-text">
            {CHAT_STRINGS.blockApproveSpectatorNote}
          </p>
        </>
      )}
      {view.kind === "resolved" && (
        <p className="chat-block-approve-status" data-status={view.status}>
          {statusLabel(view.status)}
        </p>
      )}
      {(view.kind === "actionable" || view.kind === "undetermined") && (
        <>
          {view.kind === "undetermined" && (
            <p className="chat-block-text">
              {CHAT_STRINGS.blockApproveUndeterminedNote}
            </p>
          )}
          {view.error !== null && (
            <p className="chat-block-text" role="alert">
              {view.error}
            </p>
          )}
          <ApproveButtons
            deciding={view.deciding}
            onApprove={() => decide("approve")}
            onDeny={() => decide("reject")}
          />
        </>
      )}
    </BlockCard>
  );
}
