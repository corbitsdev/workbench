import type { NativeApproval } from "../lib/approvals-api";

export type NativeApprovalCardProps = {
  approval: NativeApproval;
  requestState: "idle" | "approving" | "rejecting";
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
};

/**
 * Reads the tool name from the native approval's tool snapshot. The snapshot is
 * null until the upstream suspend-time plumbing lands, so this falls back to the
 * originating agent's mailbox local-part — the only always-present identifier of
 * what asked. Derived from the row, never a hardcoded label.
 */
function nativeHeadline(approval: NativeApproval): string {
  const def = approval.toolDefinition;
  if (def !== null) {
    const name = def["name"];
    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  }
  const local = approval.agentAddress.split("@")[0] ?? approval.agentAddress;
  return `Approval requested by ${local}`;
}

/**
 * A one-line summary of the tool arguments when the snapshot carries them.
 * Returns null (no line) when there is nothing to show yet — never a stub.
 */
function nativeArgumentSummary(approval: NativeApproval): string | null {
  const args = approval.toolArguments;
  if (args === null) return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  return keys.join(", ");
}

/**
 * Renders a native (Interchange-suspension) approval on the ReviewGate decision
 * surface. Presentation is derived entirely from the row: the tool snapshot when
 * present, else the originating agent. Approve/reject resolve through the mounted
 * native routes.
 */
export function NativeApprovalCard({
  approval,
  requestState,
  error,
  onApprove,
  onReject,
}: NativeApprovalCardProps) {
  const isApproving = requestState === "approving";
  const isRejecting = requestState === "rejecting";
  const isInFlight = isApproving || isRejecting;
  const argSummary = nativeArgumentSummary(approval);

  return (
    <div
      className="rounded bg-surface p-4 shadow-[var(--shadow-card)]"
      data-testid={`native-approval-${approval.id}`}
    >
      <div className="mb-3">
        <div className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
          Action Request
        </div>
        <p className="text-[13.5px] font-semibold text-text">
          {nativeHeadline(approval)}
        </p>
        {argSummary !== null ? (
          <p className="mt-0.5 text-[12.5px] text-text-2">{argSummary}</p>
        ) : null}
      </div>

      {error !== null && (
        <p className="mb-3 rounded-sm bg-red-soft px-3 py-1.5 text-[12px] text-red">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isInFlight}
          onClick={onApprove}
          className="rounded-input bg-charcoal px-4 py-2.5 text-sm font-semibold text-cream shadow-[var(--shadow-card)] ring-1 ring-border-strong transition-[transform,opacity] hover:bg-charcoal-deep active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
          data-testid={`native-approve-${approval.id}`}
        >
          {isApproving ? "Approving..." : "Approve"}
        </button>
        <button
          type="button"
          disabled={isInFlight}
          onClick={onReject}
          className="rounded-input bg-surface-2 px-4 py-2.5 text-sm font-semibold text-text-2 shadow-[var(--shadow-card)] transition-[transform,background-color,color] hover:bg-surface hover:text-text active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
          data-testid={`native-reject-${approval.id}`}
        >
          {isRejecting ? "Rejecting..." : "Reject"}
        </button>
      </div>
    </div>
  );
}
