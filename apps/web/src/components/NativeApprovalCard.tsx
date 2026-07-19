import { useState } from "react";
import { friendlyToolSummaryKnown } from "@workbench/agents/browser";
import { toHumanLabel } from "@workbench/ui";
import type { NativeApproval } from "../lib/approvals-api";
import type { UnresolvedToolCall } from "../lib/unresolved-tool-call";
import { providerLabel } from "../lib/tool-providers";
import {
  buildApprovalArgRows,
  type ApprovalArgRow,
  type IdResolver,
} from "../lib/native-approval-args";

/** The action a card presents: a tool name plus its arguments. */
type EffectiveTool = {
  name: string;
  arguments: Record<string, unknown>;
};

export type NativeApprovalRequestState =
  | "idle"
  | "approving"
  | "rejecting"
  | "auto-approving";

export type NativeApprovalCardProps = {
  approval: NativeApproval;
  /**
   * The single unresolved tool call in the open thread's transcript, used as
   * the action source when the backend snapshot is absent (CL-3940). Null when
   * the thread yields zero or more than one candidate — the card then shows a
   * neutral label rather than a guessed action (the no-mismatch guard).
   */
  fallbackToolCall: UnresolvedToolCall | null;
  requestState: NativeApprovalRequestState;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  /**
   * Durably auto-approve THIS card's resolved tool for the caller ("Auto
   * Approve Always"). Receives the resolved LLM-safe tool name — only invoked
   * when a tool is known, so the caller never has to guess which tool to
   * whitelist.
   */
  onAutoApprove: (toolName: string) => void;
  /**
   * Optional resolver mapping an opaque id argument (e.g. a Linear teamId) to a
   * human name from already-loaded client data. Unresolvable ids are truncated.
   */
  resolveId?: IdResolver;
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

/** A long text value renders clamped to two lines with an inline expand rather
 * than overflowing or being truncated away. */
function LongArgValue({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span>
      <span className={expanded ? "" : "line-clamp-2"}>{text}</span>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="ml-1 text-[11.5px] font-semibold text-text-3 underline underline-offset-2 hover:text-text-2"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </span>
  );
}

/** One labeled key/value row. `id`-kind values render monospace; `long` values
 * clamp with an expand; everything else is inline text. */
function ArgRow({ row }: { row: ApprovalArgRow }) {
  return (
    <div className="flex gap-2 py-[3px] text-[12.5px] leading-snug">
      <span className="w-24 shrink-0 font-semibold text-text-3">
        {row.label}
      </span>
      {row.kind === "id" ? (
        <span className="font-mono text-text-2">{row.display}</span>
      ) : row.kind === "long" ? (
        <span className="min-w-0 flex-1 text-text-2">
          <LongArgValue text={row.display} />
        </span>
      ) : (
        <span className="min-w-0 flex-1 break-words text-text-2">
          {row.display}
        </span>
      )}
    </div>
  );
}

/** Title-like keys whose value the friendly headline typically already speaks;
 * a row for one is dropped only when the headline restates it verbatim, so the
 * card never shows the same title twice. */
const TITLE_LIKE_ARG_KEYS = new Set(["title", "name", "subject"]);

/**
 * The structured argument list — a vertical set of humanized label/value rows so
 * the human approves with full, legible context (Title, Team, Priority, …), not
 * a cramped inline string. Nothing is hidden behind a "+N more"; long text
 * clamps with an expand. A title-like field already spoken by the headline is
 * deduped so the same title never appears twice.
 */
function nativeArgumentRows(
  tool: EffectiveTool | null,
  headline: string,
  resolveId: IdResolver | undefined,
): ApprovalArgRow[] {
  if (tool === null) return [];
  const rows = buildApprovalArgRows(tool.name, tool.arguments, { resolveId });
  return rows.filter((row) => {
    if (!TITLE_LIKE_ARG_KEYS.has(row.key)) return true;
    return !headline.includes(row.display);
  });
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
  onAutoApprove,
  resolveId,
}: NativeApprovalCardProps) {
  const isApproving = requestState === "approving";
  const isRejecting = requestState === "rejecting";
  const isAutoApproving = requestState === "auto-approving";
  const isInFlight = isApproving || isRejecting || isAutoApproving;
  const effectiveTool = resolveEffectiveTool(approval, fallbackToolCall);
  const headline = nativeHeadline(approval, effectiveTool);
  const argRows = nativeArgumentRows(effectiveTool, headline, resolveId);

  // "Auto Approve Always" durably whitelists a specific tool; with no resolved
  // tool we cannot know which tool to whitelist, so the option is disabled
  // rather than guessing (the no-mismatch guard extends to the durable rail).
  const toolName = effectiveTool?.name ?? null;
  const canAutoApprove = toolName !== null;

  const [confirmingAlways, setConfirmingAlways] = useState(false);

  function handleAlwaysClick() {
    if (toolName === null) return;
    if (!confirmingAlways) {
      setConfirmingAlways(true);
      return;
    }
    setConfirmingAlways(false);
    onAutoApprove(toolName);
  }

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
        {argRows.length > 0 ? (
          <div className="mt-2 rounded-sm bg-surface-2 px-3 py-2">
            {argRows.map((row) => (
              <ArgRow key={row.key} row={row} />
            ))}
          </div>
        ) : null}
      </div>

      {error !== null && (
        <p className="mb-3 rounded-sm bg-red-soft px-3 py-1.5 text-[12px] text-red">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isInFlight}
          onClick={onApprove}
          className="rounded-input bg-charcoal px-4 py-2.5 text-sm font-semibold text-cream shadow-[var(--shadow-card)] ring-1 ring-border-strong transition-[transform,opacity] hover:bg-charcoal-deep active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
          data-testid={`native-approve-${approval.id}`}
        >
          {isApproving ? "Approving..." : "Approve Once"}
        </button>
        <button
          type="button"
          disabled={isInFlight}
          onClick={onReject}
          className="rounded-input bg-surface-2 px-4 py-2.5 text-sm font-semibold text-text-2 shadow-[var(--shadow-card)] transition-[transform,background-color,color] hover:bg-surface hover:text-text active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
          data-testid={`native-reject-${approval.id}`}
        >
          {isRejecting ? "Rejecting..." : "Deny"}
        </button>
        <button
          type="button"
          disabled={isInFlight || !canAutoApprove}
          onClick={handleAlwaysClick}
          title={
            canAutoApprove
              ? "Stop asking — always approve this tool for you"
              : "The action is not identified, so it cannot be permanently approved"
          }
          className={`rounded-input px-4 py-2.5 text-sm font-semibold shadow-[var(--shadow-card)] ring-1 transition-[transform,background-color,color] active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100 ${
            confirmingAlways
              ? "bg-gold text-charcoal-deep ring-gold hover:opacity-90"
              : "bg-surface text-gold ring-gold hover:bg-surface-2"
          }`}
          data-testid={`native-auto-approve-${approval.id}`}
        >
          {isAutoApproving
            ? "Saving..."
            : confirmingAlways
              ? "Confirm — Always Approve"
              : "Auto Approve Always"}
        </button>
        {confirmingAlways && !isInFlight ? (
          <span className="text-[11.5px] text-text-3">
            Caution: this stops asking for this action.
          </span>
        ) : null}
      </div>
    </div>
  );
}
