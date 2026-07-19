import { friendlyToolSummaryKnown } from "@workbench/agents/browser";
import { toHumanLabel } from "@workbench/ui";
import type { NativeApproval } from "../lib/approvals-api";
import { providerLabel } from "../lib/tool-providers";

export type NativeApprovalCardProps = {
  approval: NativeApproval;
  requestState: "idle" | "approving" | "rejecting";
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
};

/** The tool name off the snapshot, or null when it is not yet enriched. */
function snapshotToolName(approval: NativeApproval): string | null {
  const name = approval.toolDefinition?.["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * A friendly, human action label for a gated tool name. Prefers the shared
 * `friendlyToolSummaryKnown` catalog (e.g. `linear__create_issue` → "Create a
 * Linear issue: <title>"); when a tool is not catalogued, humanizes the name
 * itself — provider + operation (`slack__post_message` → "Post Message
 * (Slack)") or, for prefix-less local tools, the bare humanized name
 * (`mail_send` → "Mail Send"). Never a raw snake_case id, never a single
 * hardcoded label.
 */
function friendlyActionLabel(
  name: string,
  args: Record<string, unknown>,
): string {
  const known = friendlyToolSummaryKnown({ name, arguments: args });
  if (known !== null) return known;
  const [provider, ...rest] = name.split("__");
  if (rest.length > 0 && provider !== undefined) {
    return `${toHumanLabel(rest.join("__"))} (${providerLabel(provider)})`;
  }
  return toHumanLabel(name);
}

/**
 * The card headline. Once the reactor snapshot has enriched the row (CL-3940)
 * this is the friendly action label; before enrichment lands it falls back to
 * the originating agent's mailbox local-part — the only always-present
 * identifier of what asked. Derived from the row, never a hardcoded label.
 */
function nativeHeadline(approval: NativeApproval): string {
  const name = snapshotToolName(approval);
  if (name !== null) {
    return friendlyActionLabel(name, approval.toolArguments ?? {});
  }
  const local = approval.agentAddress.split("@")[0] ?? approval.agentAddress;
  return `Approval requested by ${local}`;
}

/** Render a single scalar argument value inline; skip empties and nested
 * shapes (they do not read as a one-line summary). */
function formatArgValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * A one-line `key: value` summary of the tool arguments so the human approves
 * with full context (title/body/recipient), not just field names. Returns null
 * (no line) when the snapshot is absent or carries no showable scalar — never a
 * stub. Bounded to a few pairs with per-value truncation so a long body cannot
 * blow out the card.
 */
function nativeArgumentSummary(approval: NativeApproval): string | null {
  const args = approval.toolArguments;
  if (args === null) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const formatted = formatArgValue(value);
    if (formatted === null) continue;
    const truncated =
      formatted.length > 80 ? `${formatted.slice(0, 79)}…` : formatted;
    parts.push(`${key}: ${truncated}`);
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? parts.join(" · ") : null;
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
