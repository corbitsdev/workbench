// The approve card renders the PLATFORM's own account of what is being
// asked -- who, what, with which arguments, read live from the host -- as
// the authoritative description next to any live Approve/Deny buttons. The
// agent's own framing (`data.title`/`body`/`risk`) is demoted to
// contextual color: it renders alongside the platform detail, never in
// place of it, and never at all when live buttons show with no platform
// detail available (the "undetermined" 403 fallback -- see
// `approve-card-state.ts`). Nothing here is a decision: resolved state is
// always re-rendered from the host's status read, never from the block's
// own data or from a decision response the card just made. When the host
// gives no `ApprovalActions` port, the card falls back to its
// pre-round-trip framing: fixed disabled buttons, no fetch.

import { Button, toast } from "@corbits/react-ui";
import type { ApproveBlockData } from "@corbits/chat/blocks";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";
import type {
  ApprovalActions,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  PlatformApprovalDetail,
  StandingConsentOffer,
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

/** The platform's own account of the request -- always rendered first and
 * unmissable whenever it's available, so a human never decides against
 * only the agent's framing. */
function PlatformDetail({
  detail,
}: {
  readonly detail: PlatformApprovalDetail;
}) {
  const args = Object.entries(detail.arguments);
  return (
    <div className="chat-block-approve-platform">
      <p className="chat-block-approve-platform-requester">
        {CHAT_STRINGS.blockApprovePlatformRequestedBy(detail.agentName)}
      </p>
      <p className="chat-block-approve-platform-headline">{detail.headline}</p>
      {args.length > 0 && (
        <dl className="chat-block-approve-args">
          {args.map(([label, value]) => (
            <div key={label} className="chat-block-approve-arg">
              <dt>{label}</dt>
              <dd>
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ApproveButtons({
  actionLabel,
  deciding,
  onApprove,
  onDeny,
  standingConsent,
  allowingStanding,
  onAllowStanding,
}: {
  readonly actionLabel: string;
  readonly deciding: DecisionInFlight;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly standingConsent: StandingConsentOffer | undefined;
  readonly allowingStanding: boolean;
  readonly onAllowStanding: (() => void) | null;
}) {
  const busy = deciding !== null;
  return (
    <div className="chat-block-actions-group">
      <div className="chat-block-actions">
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={onApprove}
        >
          {deciding === "approve"
            ? CHAT_STRINGS.blockApproveApproving
            : actionLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onDeny}
        >
          {deciding === "reject"
            ? CHAT_STRINGS.blockApproveRejecting
            : CHAT_STRINGS.blockDenyAction}
        </Button>
      </div>
      {standingConsent !== undefined && onAllowStanding !== null && (
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={busy || allowingStanding}
          onClick={onAllowStanding}
        >
          {CHAT_STRINGS.blockApproveAllowStanding(standingConsent)}
        </Button>
      )}
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
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);
  const [allowingStanding, setAllowingStanding] = useState(false);

  useEffect(() => {
    if (actions === undefined) return;
    let cancelled = false;
    setLive({ kind: "loading" });
    setResolvedElsewhere(false);
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
          setResolvedElsewhere(false);
          toast(
            kind === "approve"
              ? CHAT_STRINGS.blockApproveStatusApproved
              : CHAT_STRINGS.blockApproveStatusRejected,
          );
        } else if (result.kind === "conflict") {
          // Someone/something else resolved this first. There is nothing
          // to retry -- re-sync below and let the refreshed terminal
          // status speak, with a calmer note than a bare error.
          setResolvedElsewhere(true);
        } else {
          setResolvedElsewhere(false);
          setDecisionError(
            result.kind === "forbidden"
              ? CHAT_STRINGS.blockApproveActionForbidden
              : CHAT_STRINGS.blockApproveActionError,
          );
        }
        // Never trust the decision response (or a local guess) over the
        // platform's own state -- re-read it after every outcome, success
        // or failure alike, and render only what comes back.
        return actions.getStatus(data.approvalId).then(setLive);
      })
      .finally(() => setDeciding(null));
  }

  function allowStanding() {
    if (actions?.allowStanding === undefined) return;
    setAllowingStanding(true);
    actions
      .allowStanding(data.approvalId)
      .then((result) => {
        if (result.kind === "resolved") {
          toast(CHAT_STRINGS.blockApproveStatusApproved);
        } else if (result.kind !== "conflict") {
          setDecisionError(
            result.kind === "forbidden"
              ? CHAT_STRINGS.blockApproveActionForbidden
              : CHAT_STRINGS.blockApproveActionError,
          );
        }
        return actions.getStatus(data.approvalId).then(setLive);
      })
      .finally(() => setAllowingStanding(false));
  }

  const view = deriveApproveCardView({
    wired: actions !== undefined,
    live,
    deciding,
    decisionError,
    resolvedElsewhere,
  });

  const detail =
    view.kind === "actionable" ||
    view.kind === "spectator" ||
    view.kind === "resolved"
      ? view.detail
      : null;

  return (
    <BlockCard title={data.title}>
      {detail !== null && <PlatformDetail detail={detail} />}
      {detail?.consequence !== undefined && (
        <p className="chat-block-text chat-block-consequence">
          {detail.consequence}
        </p>
      )}
      {view.kind !== "undetermined" && data.body !== undefined && (
        <p className="chat-block-text chat-block-agent-note">
          {detail !== null
            ? `${CHAT_STRINGS.blockApproveAgentNoteLabel}: `
            : ""}
          {data.body}
        </p>
      )}
      {view.kind === "unwired" && (
        <div className="chat-block-actions">
          <Button type="button" variant="primary" disabled>
            {CHAT_STRINGS.blockApproveAction}
          </Button>
          <Button type="button" variant="outline" disabled>
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
          <p className="chat-block-text">
            {CHAT_STRINGS.blockApproveSpectatorNote}
          </p>
        </>
      )}
      {view.kind === "resolved" && (
        <>
          <p className="chat-block-approve-status" data-status={view.status}>
            {statusLabel(view.status)}
          </p>
          {view.resolvedElsewhere && (
            <p className="chat-block-text">
              {CHAT_STRINGS.blockApproveConflictNote}
            </p>
          )}
        </>
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
            actionLabel={detail?.actionVerb ?? CHAT_STRINGS.blockApproveAction}
            deciding={view.deciding}
            onApprove={() => decide("approve")}
            onDeny={() => decide("reject")}
            standingConsent={detail?.standingConsent}
            allowingStanding={allowingStanding}
            onAllowStanding={
              actions?.allowStanding !== undefined ? allowStanding : null
            }
          />
        </>
      )}
    </BlockCard>
  );
}
