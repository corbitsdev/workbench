import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { friendlyToolSummary } from "@workbench/agents/browser";
import type { ToolCall } from "@workbench/chat";
import {
  approveRequest,
  listApprovals,
  rejectRequest,
} from "../lib/approvals-api";
import type { Approval } from "../lib/approvals-api";

// Polling interval while there are pending approvals.
const POLL_INTERVAL_MS = 3000;
// Polling interval when idle (no pending approvals visible).
const POLL_IDLE_MS = 8000;

export type ReviewGateProps = {
  /** Interchange tenant ID used to scope approval requests. */
  tenantId: string;
  /**
   * Optional Interchange session ID. When provided, only approvals whose
   * sessionId matches are shown. When omitted, all tenant-level pending
   * approvals are shown.
   */
  sessionId?: string;
};

type RequestState = "idle" | "approving" | "rejecting";

/**
 * Builds a synthetic tool call from an approval so the same humanizer that
 * labels tool activity in chat (`friendlyToolSummary`) can describe what the
 * agent is asking to run. The `resource` carries the tool id (often
 * `tool:<name>`); `context` carries the arguments.
 */
function approvalToToolCall(approval: Approval): ToolCall {
  return {
    id: approval.id,
    name: approval.resource.replace(/^tool:/u, ""),
    arguments: approval.context ?? undefined,
  };
}

/**
 * The line-one headline: the humanized verb phrase when we can produce one,
 * otherwise the backend's own action sentence. `friendlyToolSummary` falls back
 * to a soft "Working on …" for tool ids it does not recognize — in that case
 * the backend's `action` is the more specific, honest description.
 */
function headlineFor(approval: Approval): string {
  const summary = friendlyToolSummary(approvalToToolCall(approval));
  if (summary.startsWith("Working on ")) return approval.action;
  return summary;
}

function humanizeKey(key: string): string {
  const words = key.split(/[-_]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

export function ReviewGate({ tenantId, sessionId }: ReviewGateProps) {
  const queryClient = useQueryClient();
  const prefersReducedMotion = useReducedMotion();
  const { data: approvals = [], error: fetchError } = useQuery({
    queryKey: ["approvals", tenantId, sessionId],
    queryFn: async () => {
      const all = await listApprovals(tenantId);
      return sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    },
    refetchInterval: (query) => {
      const data = query.state.data ?? [];
      return data.some((a) => a.status === "pending")
        ? POLL_INTERVAL_MS
        : POLL_IDLE_MS;
    },
  });

  const [itemStates, setItemStates] = useState<
    Map<string, { requestState: RequestState; error: string | null }>
  >(new Map());

  function getItemState(id: string) {
    return (
      itemStates.get(id) ?? {
        requestState: "idle" as RequestState,
        error: null,
      }
    );
  }

  function patchItemState(
    id: string,
    patch: { requestState?: RequestState; error?: string | null },
  ) {
    setItemStates((prev) => {
      const current = prev.get(id) ?? {
        requestState: "idle" as RequestState,
        error: null,
      };
      const next = new Map(prev);
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  if (approvals.length === 0 && !fetchError) return null;

  async function handleApprove(id: string) {
    patchItemState(id, { requestState: "approving", error: null });
    try {
      await approveRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["approvals", tenantId, sessionId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Approval failed.",
      });
    }
  }

  async function handleReject(id: string) {
    patchItemState(id, { requestState: "rejecting", error: null });
    try {
      await rejectRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["approvals", tenantId, sessionId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Rejection failed.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="review-gate">
      {fetchError !== null && (
        <p className="rounded-sm bg-red-soft px-3 py-2 text-[13px] text-red">
          {fetchError instanceof Error
            ? fetchError.message
            : "Failed to load approval requests."}
        </p>
      )}
      <AnimatePresence initial={false}>
        {approvals.map((approval: Approval) => {
          const { requestState, error } = getItemState(approval.id);
          const isPending = approval.status === "pending";
          const isApproving = requestState === "approving";
          const isRejecting = requestState === "rejecting";
          const isInFlight = isApproving || isRejecting;
          const headline = headlineFor(approval);
          const showActionDetail = headline !== approval.action;
          const contextEntries =
            approval.context !== null ? Object.entries(approval.context) : [];

          const restOpacity = isPending ? 1 : 0.5;

          return (
            <motion.div
              key={approval.id}
              layout={!prefersReducedMotion}
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.98, y: 4 }
              }
              animate={
                prefersReducedMotion
                  ? { opacity: restOpacity }
                  : { opacity: restOpacity, scale: 1, y: 0 }
              }
              exit={
                // A cleared approval should feel responsive: leave faster than
                // it arrives, so the exit carries its own quicker transition.
                prefersReducedMotion
                  ? { opacity: 0, transition: { duration: 0.12 } }
                  : {
                      opacity: 0,
                      scale: 0.98,
                      y: 4,
                      transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] },
                    }
              }
              transition={{
                duration: 0.18,
                ease: [0.23, 1, 0.32, 1],
              }}
              className="rounded bg-surface p-4 shadow-[var(--shadow-card)]"
              data-testid={`approval-${approval.id}`}
            >
              <div className="mb-3">
                <div className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
                  Action Request
                </div>
                <p className="text-[13.5px] font-semibold text-text">
                  {headline}
                </p>
                {showActionDetail && (
                  <p className="mt-0.5 text-[12.5px] text-text-2">
                    {approval.action}
                  </p>
                )}
                <p className="mt-0.5 font-mono text-[11px] text-text-3">
                  {approval.resource}
                </p>
                {contextEntries.length > 0 && (
                  <dl className="mt-2 flex flex-col gap-1 rounded-sm bg-bg px-3 py-2">
                    {contextEntries.map(([key, value]) => (
                      <div key={key} className="flex gap-2 text-[12px]">
                        <dt className="shrink-0 font-medium text-text-3">
                          {humanizeKey(key)}
                        </dt>
                        <dd className="min-w-0 break-words text-text-2">
                          {formatValue(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>

              {error !== null && (
                <p className="mb-3 rounded-sm bg-red-soft px-3 py-1.5 text-[12px] text-red">
                  {error}
                </p>
              )}

              {isPending ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isInFlight}
                    onClick={() => void handleApprove(approval.id)}
                    className="rounded-input bg-charcoal px-4 py-2.5 text-sm font-semibold text-cream shadow-[var(--shadow-card)] ring-1 ring-border-strong transition-[transform,opacity] hover:bg-charcoal-deep active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
                    data-testid={`approve-${approval.id}`}
                  >
                    {isApproving ? "Approving..." : "Approve"}
                  </button>
                  <button
                    type="button"
                    disabled={isInFlight}
                    onClick={() => void handleReject(approval.id)}
                    className="rounded-input bg-surface-2 px-4 py-2.5 text-sm font-semibold text-text-2 shadow-[var(--shadow-card)] transition-[transform,background-color,color] hover:bg-surface hover:text-text active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
                    data-testid={`reject-${approval.id}`}
                  >
                    {isRejecting ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              ) : (
                <span
                  className={`inline-block rounded-full px-2 py-0.5 font-mono text-[11px] ${
                    approval.status === "approved"
                      ? "bg-green-soft text-green"
                      : "bg-red-soft text-red"
                  }`}
                >
                  {approval.status}
                </span>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
