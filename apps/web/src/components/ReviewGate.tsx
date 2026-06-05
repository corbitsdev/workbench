import { useCallback, useEffect, useRef, useState } from 'react';
import { approveRequest, listApprovals, rejectRequest } from '../lib/approvals-api';
import type { Approval, ApproveScope } from '../lib/approvals-api';

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

type RequestState = 'idle' | 'approving' | 'rejecting';

type ApprovalItemState = {
  approval: Approval;
  /** Per-item in-flight state. */
  requestState: RequestState;
  /** Error from the most recent approve/reject attempt. */
  error: string | null;
};

function buildItemState(approval: Approval): ApprovalItemState {
  return { approval, requestState: 'idle', error: null };
}

export function ReviewGate({ tenantId, sessionId }: ReviewGateProps) {
  const [items, setItems] = useState<ApprovalItemState[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const scheduleNextPoll = useCallback(
    (hasPending: boolean) => {
      stopPolling();
      pollRef.current = setTimeout(() => void poll(), hasPending ? POLL_INTERVAL_MS : POLL_IDLE_MS);
    },
    // poll is defined below; we break the cycle via a ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stopPolling]
  );

  const poll = useCallback(async () => {
    try {
      const all = await listApprovals(tenantId);
      const filtered = sessionId ? all.filter((a) => a.sessionId === sessionId) : all;

      setFetchError(null);
      setItems((prev) => {
        // Merge: preserve per-item request state for items already in flight.
        const prevMap = new Map(prev.map((i) => [i.approval.id, i]));
        return filtered.map((approval) => {
          const existing = prevMap.get(approval.id);
          // If the item was in flight but the server now shows it resolved,
          // adopt the resolved state but clear the in-flight flag.
          if (existing && existing.requestState !== 'idle') {
            if (approval.status !== 'pending') {
              return { ...existing, approval, requestState: 'idle' as RequestState };
            }
            return { ...existing, approval };
          }
          return existing ? { ...existing, approval } : buildItemState(approval);
        });
      });

      const hasPending = filtered.some((a) => a.status === 'pending');
      scheduleNextPoll(hasPending);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load approval requests.');
      scheduleNextPoll(false);
    }
  }, [tenantId, sessionId, scheduleNextPoll]);

  useEffect(() => {
    void poll();
    return stopPolling;
    // Run once on mount and whenever tenantId/sessionId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, sessionId]);

  function setItemState(id: string, patch: Partial<ApprovalItemState>) {
    setItems((prev) => prev.map((i) => (i.approval.id === id ? { ...i, ...patch } : i)));
  }

  async function handleApprove(id: string, scope: ApproveScope) {
    setItemState(id, { requestState: 'approving', error: null });
    try {
      const updated = await approveRequest(tenantId, id, scope);
      setItemState(id, { approval: updated, requestState: 'idle' });
    } catch (err) {
      setItemState(id, {
        requestState: 'idle',
        error: err instanceof Error ? err.message : 'Approval failed.',
      });
    }
  }

  async function handleReject(id: string) {
    setItemState(id, { requestState: 'rejecting', error: null });
    try {
      const updated = await rejectRequest(tenantId, id);
      setItemState(id, { approval: updated, requestState: 'idle' });
    } catch (err) {
      setItemState(id, {
        requestState: 'idle',
        error: err instanceof Error ? err.message : 'Rejection failed.',
      });
    }
  }

  // Nothing to show — no items and no fetch error.
  if (items.length === 0 && fetchError === null) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="review-gate">
      {fetchError !== null && (
        <p className="rounded-[8px] bg-red-500/10 px-3 py-2 text-[13px] text-red-400">
          {fetchError}
        </p>
      )}
      {items.map(({ approval, requestState, error }) => {
        const isPending = approval.status === 'pending';
        const isApproving = requestState === 'approving';
        const isRejecting = requestState === 'rejecting';
        const isInFlight = isApproving || isRejecting;

        return (
          <div
            key={approval.id}
            className={`rounded-[12px] border border-border bg-surface p-4 transition-opacity ${
              !isPending ? 'opacity-50' : ''
            }`}
            data-testid={`approval-${approval.id}`}
          >
            <div className="mb-3">
              <div className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
                Action Request
              </div>
              <p className="text-[13.5px] font-medium text-text">{approval.action}</p>
              <p className="mt-0.5 font-mono text-[11px] text-text-3">{approval.resource}</p>
              {approval.context !== null && Object.keys(approval.context).length > 0 && (
                <div className="mt-2 rounded-[8px] bg-bg px-3 py-2">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-text-2">
                    {JSON.stringify(approval.context, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {error !== null && (
              <p className="mb-3 rounded-[8px] bg-red-500/10 px-3 py-1.5 text-[12px] text-red-400">
                {error}
              </p>
            )}

            {isPending ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isInFlight}
                  onClick={() => void handleApprove(approval.id, 'once')}
                  className="rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[6px] text-[12.5px] font-semibold text-cream transition-opacity disabled:opacity-40"
                  data-testid={`approve-${approval.id}`}
                >
                  {isApproving ? 'Approving...' : 'Approve'}
                </button>
                <button
                  type="button"
                  disabled={isInFlight}
                  onClick={() => void handleReject(approval.id)}
                  className="rounded-[9px] border border-border px-[13px] py-[6px] text-[12.5px] font-semibold text-text-2 transition-colors hover:bg-surface disabled:opacity-40"
                  data-testid={`reject-${approval.id}`}
                >
                  {isRejecting ? 'Rejecting...' : 'Reject'}
                </button>
              </div>
            ) : (
              <span
                className={`inline-block rounded-full px-2 py-0.5 font-mono text-[11px] ${
                  approval.status === 'approved'
                    ? 'bg-green/10 text-green'
                    : 'bg-red-500/10 text-red-400'
                }`}
              >
                {approval.status}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
