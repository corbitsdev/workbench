import { friendlyToolSummaryKnown } from "@workbench/agents/browser";
import { toHumanLabel } from "@workbench/ui";
import type { NativeApproval } from "../lib/approvals-api";
import type { UnresolvedToolCall } from "../lib/unresolved-tool-call";
import { providerLabel } from "../lib/tool-providers";

/** The action a card presents: a tool name plus its arguments. */
type EffectiveTool = {
  name: string;
  arguments: Record<string, unknown>;
};

export type NativeApprovalCardProps = {
  approval: NativeApproval;
  /**
   * The single unresolved tool call in the open thread's transcript, used as
   * the action source when the backend snapshot is absent (CL-3940). Null when
   * the thread yields zero or more than one candidate — the card then shows a
   * neutral label rather than a guessed action (the no-mismatch guard).
   */
  fallbackToolCall: UnresolvedToolCall | null;
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
 * The action a card presents, by precedence (CL-3940): (a) the backend tool
 * snapshot when present; (b) else the open thread's single unresolved tool
 * call; (c) else null → the card shows the neutral originating-agent fallback.
 */
function resolveEffectiveTool(
  approval: NativeApproval,
  fallbackToolCall: UnresolvedToolCall | null,
): EffectiveTool | null {
  const snapshotName = snapshotToolName(approval);
  if (snapshotName !== null) {
    return { name: snapshotName, arguments: approval.toolArguments ?? {} };
  }
  if (fallbackToolCall !== null) {
    return {
      name: fallbackToolCall.name,
      arguments: fallbackToolCall.arguments,
    };
  }
  return null;
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
 * The card headline. When an action is resolved (backend snapshot or the open
 * thread's single unresolved tool call, CL-3940) this is the friendly action
 * label; with neither it falls back to the originating agent's mailbox
 * local-part — the only always-present identifier of what asked. Derived from
 * the row/transcript, never a hardcoded label.
 */
function nativeHeadline(
  approval: NativeApproval,
  tool: EffectiveTool | null,
): string {
  if (tool !== null) {
    return friendlyActionLabel(tool.name, tool.arguments);
  }
  const local = approval.agentAddress.split("@")[0] ?? approval.agentAddress;
  return `Approval requested by ${local}`;
}

/** Keys whose value is typically already spoken by the friendly headline
 * (e.g. `Creating Linear issue "<title>"`), so repeating them in the arg line
 * is noise. Only deduped when the value actually appears in the headline. */
const TITLE_LIKE_ARG_KEYS = new Set(["title", "name", "subject"]);

/** The most argument pairs we show inline before collapsing the rest into a
 * "+N more" cue. */
const MAX_ARG_PAIRS = 3;

/** Render a single scalar argument value inline; null for empties. */
function formatScalarArg(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Render an array argument as a readable, truncated list — a `to: string[]`
 * recipient list is exactly what an approver must see, so it must never be
 * dropped. A short list renders its members (`a@x.com, b@y.com`); a long or
 * non-scalar list collapses to a `N items` count rather than an unreadable
 * blob.
 */
function formatArrayArg(value: unknown[]): string | null {
  if (value.length === 0) return null;
  const items = value
    .map(formatScalarArg)
    .filter((item): item is string => item !== null);
  if (items.length === value.length) {
    const joined = items.join(", ");
    if (items.length <= 4 && joined.length <= 60) return joined;
  }
  return `${value.length} items`;
}

/** Render an object argument compactly — a couple of its own scalar fields so a
 * nested shape still surfaces something the approver can read. */
function formatObjectArg(value: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const formatted = formatScalarArg(inner);
    if (formatted === null) continue;
    parts.push(`${key}: ${formatted}`);
    if (parts.length >= 2) break;
  }
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : null;
}

/** Format any argument value — scalar, array, or object — for the inline
 * summary. Null only when the value carries nothing showable. */
function formatArgValue(value: unknown): string | null {
  if (Array.isArray(value)) return formatArrayArg(value);
  if (value !== null && typeof value === "object") {
    return formatObjectArg(value as Record<string, unknown>);
  }
  return formatScalarArg(value);
}

/**
 * A one-line `key: value` summary of the tool arguments so the human approves
 * with full context (title/body/recipient list), not just field names. Returns
 * null (no line) when the snapshot is absent or carries nothing showable —
 * never a stub. Bounded to a few pairs with per-value truncation so a long body
 * cannot blow out the card; arrays and objects are rendered rather than
 * silently dropped. Fields already spoken by `headline` are deduped so the
 * title is not repeated. When pairs are capped or any field is hidden, a
 * "+N more" cue is appended so nothing is dropped without a trace.
 */
function nativeArgumentSummary(
  tool: EffectiveTool | null,
  headline: string,
): string | null {
  if (tool === null) return null;
  const args = tool.arguments;
  const candidates = Object.entries(args).filter(([key, value]) => {
    if (!TITLE_LIKE_ARG_KEYS.has(key)) return true;
    const formatted = formatScalarArg(value);
    return formatted === null || !headline.includes(formatted);
  });
  const parts: string[] = [];
  let shown = 0;
  for (const [key, value] of candidates) {
    if (parts.length >= MAX_ARG_PAIRS) break;
    const formatted = formatArgValue(value);
    if (formatted === null) continue;
    const truncated =
      formatted.length > 80 ? `${formatted.slice(0, 79)}…` : formatted;
    parts.push(`${key}: ${truncated}`);
    shown += 1;
  }
  if (parts.length === 0) return null;
  const overflow = candidates.length - shown;
  if (overflow > 0) parts.push(`+${overflow} more`);
  return parts.join(" · ");
}

/**
 * Renders a native (Interchange-suspension) approval on the ReviewGate decision
 * surface. Presentation is derived entirely from the row: the tool snapshot when
 * present, else the originating agent. Approve/reject resolve through the mounted
 * native routes.
 */
export function NativeApprovalCard({
  approval,
  fallbackToolCall,
  requestState,
  error,
  onApprove,
  onReject,
}: NativeApprovalCardProps) {
  const isApproving = requestState === "approving";
  const isRejecting = requestState === "rejecting";
  const isInFlight = isApproving || isRejecting;
  const effectiveTool = resolveEffectiveTool(approval, fallbackToolCall);
  const headline = nativeHeadline(approval, effectiveTool);
  const argSummary = nativeArgumentSummary(effectiveTool, headline);

  return (
    <div
      className="rounded bg-surface p-4 shadow-[var(--shadow-card)]"
      data-testid={`native-approval-${approval.id}`}
    >
      <div className="mb-3">
        <div className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
          Action Request
        </div>
        <p className="text-[13.5px] font-semibold text-text">{headline}</p>
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
