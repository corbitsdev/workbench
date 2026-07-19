import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { friendlyToolSummaryKnown } from "@workbench/agents/browser";
import type { ToolCall } from "@workbench/chat";
import {
  approveRequest,
  approveNativeRequest,
  listApprovals,
  listNativeApprovals,
  rejectRequest,
  rejectNativeRequest,
  subscribeApprovals,
} from "../lib/approvals-api";
import type { Approval, NativeApproval } from "../lib/approvals-api";
import { logger } from "../lib/logger";
import { NativeApprovalCard } from "./NativeApprovalCard";
import {
  humanizeApprovalValue,
  isMailSendApproval,
  mailSendContext,
  mailSendToolSummaryHeadline,
} from "../lib/approval-display";
import { useApprovalDisplayLookups } from "../hooks/use-approval-display-lookups";
import { MailSendApprovalDetails } from "./MailSendApprovalDetails";

export type ReviewGateProps = {
  /** Interchange tenant ID used to scope approval requests. */
  tenantId: string;
  /**
   * Interchange session ID. When `sessionScope` is `"session"`, only approvals
   * whose sessionId matches are shown. When `sessionScope` is `"tenant"`, a
   * provided id filters; when omitted, all tenant pending approvals are shown.
   */
  sessionId?: string;
  /**
   * `"session"` (Myra chat): show nothing until `sessionId` is known, then
   * filter to that session. `"tenant"`: fall back to all tenant approvals when
   * `sessionId` is omitted.
   */
  sessionScope?: "tenant" | "session";
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
 * The line-one headline: the humanized verb phrase when the tool is recognized,
 * otherwise the backend's own action sentence. `friendlyToolSummaryKnown`
 * returns null for unrecognized tool ids — for those the backend's `action` is
 * the more specific, honest description.
 */
function headlineFor(
  approval: Approval,
  lookups: Parameters<typeof mailSendToolSummaryHeadline>[1],
  lookupsLoading: boolean,
): string {
  if (isMailSendApproval(approval.resource)) {
    const ctx = mailSendContext(approval.context);
    return mailSendToolSummaryHeadline(ctx?.to, lookups, lookupsLoading);
  }
  return (
    friendlyToolSummaryKnown(approvalToToolCall(approval)) ?? approval.action
  );
}

/**
 * Secondary label under the headline. Recognized tools use the catalog phrase
 * with no argument interpolation (same idle frame as chat `formatToolName`).
 * Unknown tools omit the line so we never show a soft "Working on …" caption
 * under a backend action headline. Mail send omits the line too.
 */
function resourceCaption(approval: Approval): string | null {
  if (isMailSendApproval(approval.resource)) return null;
  if (approval.resource.startsWith("tool:")) {
    const call = approvalToToolCall(approval);
    return friendlyToolSummaryKnown({
      id: call.id,
      name: call.name,
      arguments: {},
    });
  }
  return approval.resource;
}

function humanizeKey(key: string): string {
  const words = key.split(/[-_]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Inline context values longer than this are truncated with a Show more control
// so Action Request cards stay scannable (e.g. full HTML deploy bodies).
const CONTEXT_VALUE_TRUNCATE_AT = 240;

// Untrusted model-generated HTML in approval context: null-origin sandbox (no
// allow-same-origin), scripts only — same posture as web artifact previews.
const CONTEXT_HTML_SANDBOX = "allow-scripts";

function isHTMLAtDocumentStart(sample: string): boolean {
  const head = sample.trimStart().slice(0, 256).toLowerCase();
  if (head.startsWith("<!doctype html")) return true;
  return /^<html[\s>/]/.test(head);
}

function isHTMLDocument(value: string): boolean {
  if (isHTMLAtDocumentStart(value)) return true;
  const withoutLeadingComment = value
    .trimStart()
    .replace(/^<!--[\s\S]*?-->\s*/, "");
  if (withoutLeadingComment !== value.trimStart()) {
    return isHTMLAtDocumentStart(withoutLeadingComment);
  }
  return false;
}

function formatSizeLabel(charCount: number): string {
  if (charCount < 1024) return `${String(charCount)} chars`;
  const kb = charCount / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${String(Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function isBlockContextValue(value: unknown): boolean {
  if (typeof value === "string") {
    return isHTMLDocument(value) || value.length > CONTEXT_VALUE_TRUNCATE_AT;
  }
  if (value !== null && typeof value === "object") {
    return stringifyValue(value).length > CONTEXT_VALUE_TRUNCATE_AT;
  }
  return false;
}

function ContextValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);

  if (typeof value === "string" && isHTMLDocument(value)) {
    return (
      <div
        className="flex w-full min-w-0 flex-col gap-1.5"
        data-testid="context-html-preview"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-text-3">
            HTML document · {formatSizeLabel(value.length)}
          </span>
          <button
            type="button"
            onClick={() => setShowSource((prev) => !prev)}
            className="text-[11px] font-medium text-orange underline-offset-2 hover:underline"
          >
            {showSource ? "Show preview" : "View source"}
          </button>
        </div>
        {showSource ? (
          <div className="min-w-0">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-2">
              {expanded
                ? value
                : `${value.slice(0, CONTEXT_VALUE_TRUNCATE_AT)}…`}
            </pre>
            {value.length > CONTEXT_VALUE_TRUNCATE_AT ? (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="mt-1 text-[11px] font-medium text-orange underline-offset-2 hover:underline"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="h-40 overflow-hidden rounded-sm border border-border bg-white">
            <iframe
              srcDoc={value}
              title="HTML preview"
              sandbox={CONTEXT_HTML_SANDBOX}
              className="h-full w-full border-0 bg-white"
            />
          </div>
        )}
      </div>
    );
  }

  const text = stringifyValue(value);
  if (text.length <= CONTEXT_VALUE_TRUNCATE_AT) {
    return text;
  }

  return (
    <div className="min-w-0" data-testid="context-truncated-value">
      <span className="break-words">
        {expanded ? text : `${text.slice(0, CONTEXT_VALUE_TRUNCATE_AT)}…`}
      </span>{" "}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="text-[11px] font-medium text-orange underline-offset-2 hover:underline"
      >
        {expanded
          ? "Show less"
          : `Show more (${formatSizeLabel(text.length - CONTEXT_VALUE_TRUNCATE_AT)} more)`}
      </button>
    </div>
  );
}

export function ReviewGate({
  tenantId,
  sessionId,
  sessionScope = "tenant",
}: ReviewGateProps) {
  const queryClient = useQueryClient();
  const { lookups, isLoading: lookupsLoading } =
    useApprovalDisplayLookups(tenantId);
  const prefersReducedMotion = useReducedMotion();
  const enabled = tenantId !== "";
  const sessionFilterReady =
    sessionScope === "tenant" || (sessionId !== undefined && sessionId !== "");
  const { data: approvals = [] } = useQuery({
    queryKey: ["approvals", tenantId, sessionId, sessionScope],
    enabled: enabled && sessionFilterReady,
    queryFn: async () => {
      const all = await listApprovals(tenantId);
      if (sessionScope === "session" && sessionId) {
        return all.filter((a) => a.sessionId === sessionId);
      }
      return sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    },
  });

  // The native rail is tenant-wide: a suspended tool call has no session
  // linkage (the `approval` row carries no sessionId), so it surfaces in every
  // ReviewGate for the tenant regardless of session scope — a member sees
  // pending items from either rail during the soak.
  const { data: nativeApprovals = [] } = useQuery({
    queryKey: ["native-approvals", tenantId],
    enabled,
    queryFn: () => listNativeApprovals(tenantId),
  });

  // Event-driven refresh replaces the former unconditional poll (CL-3285): the
  // gate fetches once on mount, then refetches only when the hub pushes an
  // approval change. An idle chat with no pending approvals issues no repeating
  // requests. The event is a change notification, so we always invalidate and
  // let the ownership-scoped list route decide what the caller may see rather
  // than trusting the broadcast payload.
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeApprovals(
      tenantId,
      (event) => {
        if (sessionId && event.sessionId && event.sessionId !== sessionId) {
          return;
        }
        void queryClient.invalidateQueries({
          queryKey: ["approvals", tenantId, sessionId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["native-approvals", tenantId],
        });
      },
      // A terminally-failed stream (never opened) would otherwise leave the gate
      // silently stale until the next window-focus refetch. Log it so the drop
      // is at least visible to operators rather than swallowed.
      (error) => {
        logger.warn("Approvals stream connection failed", error.message);
      },
    );
    return unsubscribe;
  }, [enabled, tenantId, sessionId, queryClient]);

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

  if (approvals.length === 0 && nativeApprovals.length === 0) return null;

  async function handleApprove(id: string) {
    patchItemState(id, { requestState: "approving", error: null });
    try {
      await approveRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["approvals", tenantId, sessionId, sessionScope],
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
        queryKey: ["approvals", tenantId, sessionId, sessionScope],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Rejection failed.",
      });
    }
  }

  async function handleApproveNative(id: string) {
    patchItemState(id, { requestState: "approving", error: null });
    try {
      await approveNativeRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["native-approvals", tenantId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Approval failed.",
      });
    }
  }

  async function handleRejectNative(id: string) {
    patchItemState(id, { requestState: "rejecting", error: null });
    try {
      await rejectNativeRequest(tenantId, id);
      patchItemState(id, { requestState: "idle" });
      await queryClient.invalidateQueries({
        queryKey: ["native-approvals", tenantId],
      });
    } catch (err) {
      patchItemState(id, {
        requestState: "idle",
        error: err instanceof Error ? err.message : "Rejection failed.",
      });
    }
  }

  function renderLegacyCard(approval: Approval) {
    const { requestState, error } = getItemState(approval.id);
    const isPending = approval.status === "pending";
    const isApproving = requestState === "approving";
    const isRejecting = requestState === "rejecting";
    const isInFlight = isApproving || isRejecting;
    const headline = headlineFor(approval, lookups, lookupsLoading);
    const showActionDetail =
      headline !== approval.action && !isMailSendApproval(approval.resource);
    const mailSend = isMailSendApproval(approval.resource)
      ? mailSendContext(approval.context)
      : null;
    const contextEntries =
      approval.context !== null && mailSend === null
        ? Object.entries(approval.context)
        : [];
    const resourceLine = (() => {
      const caption = resourceCaption(approval);
      if (caption === null) return null;
      if (caption === headline) return null;
      return caption;
    })();

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
          <p className="text-[13.5px] font-semibold text-text">{headline}</p>
          {showActionDetail && (
            <p className="mt-0.5 text-[12.5px] text-text-2">
              {approval.action}
            </p>
          )}
          {resourceLine !== null ? (
            <p className="mt-0.5 text-[11px] text-text-3">{resourceLine}</p>
          ) : null}
          {mailSend !== null ? (
            <MailSendApprovalDetails
              context={mailSend}
              lookups={lookups}
              lookupsLoading={lookupsLoading}
            />
          ) : null}
          {contextEntries.length > 0 && (
            <dl className="mt-2 flex flex-col gap-1.5 rounded-sm bg-bg px-3 py-2">
              {contextEntries.map(([key, value]) => {
                const displayValue = humanizeApprovalValue(value, lookups, key);
                const block = isBlockContextValue(displayValue);
                return (
                  <div
                    key={key}
                    className={
                      block
                        ? "flex flex-col gap-1 text-[12px]"
                        : "flex gap-2 text-[12px]"
                    }
                  >
                    <dt className="shrink-0 font-medium text-text-3">
                      {humanizeKey(key)}
                    </dt>
                    <dd className="min-w-0 break-words text-text-2">
                      <ContextValue value={displayValue} />
                    </dd>
                  </div>
                );
              })}
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
  }

  function renderNativeCard(native: NativeApproval) {
    const { requestState, error } = getItemState(native.id);
    return (
      <NativeApprovalCard
        key={native.id}
        approval={native}
        requestState={requestState}
        error={error}
        onApprove={() => void handleApproveNative(native.id)}
        onReject={() => void handleRejectNative(native.id)}
      />
    );
  }

  // Merge both rails into one queue ordered newest-first by createdAt, so "what
  // to review first" reads reliably top-to-bottom instead of legacy-then-native.
  const queue: { id: string; createdAt: string; node: ReactNode }[] = [
    ...approvals.map((a: Approval) => ({
      id: a.id,
      createdAt: a.createdAt,
      node: renderLegacyCard(a),
    })),
    ...nativeApprovals.map((n: NativeApproval) => ({
      id: n.id,
      createdAt: n.createdAt,
      node: renderNativeCard(n),
    })),
  ].sort((x, y) => y.createdAt.localeCompare(x.createdAt));

  return (
    <div className="flex flex-col gap-2" data-testid="review-gate">
      <AnimatePresence initial={false}>
        {queue.map((item) => item.node)}
      </AnimatePresence>
    </div>
  );
}
