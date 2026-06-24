import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

export function ReviewGate({ tenantId, sessionId }: ReviewGateProps) {
  const queryClient = useQueryClient();
  const { data: approvals = [], error: fetchError } = useQuery({
    queryKey: ['approvals', tenantId, sessionId],
    queryFn: async () => {
      const all = await listApprovals(tenantId);
      return sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    },
    refetchInterval: (query) => {
      const data = query.state.data ?? [];
      return data.some((a) => a.status === 'pending') ? POLL_INTERVAL_MS : POLL_IDLE_MS;
    },
  });

  const [itemStates, setItemStates] = useState<
    Map<string, { requestState: RequestState; error: string | null }>
  >(new Map());

  function getItemState(id: string) {
    return itemStates.get(id) ?? { requestState: 'idle' as RequestState, error: null };
  }

  function patchItemState(
    id: string,
    patch: { requestState?: RequestState; error?: string | null }
  ) {
    setItemStates((prev) => {
      const current = prev.get(id) ?? { requestState: 'idle' as RequestState, error: null };
      const next = new Map(prev);
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  if (approvals.length === 0 && !fetchError) return null;

  async function handleApprove(id: string, scope: ApproveScope) {
    patchItemState(id, { requestState: 'approving', error: null });
    try {
      await approveRequest(tenantId, id, scope);
      patchItemState(id, { requestState: 'idle' });
      await queryClient.invalidateQueries({ queryKey: ['approvals', tenantId, sessionId] });
    } catch (err) {
      patchItemState(id, {
        requestState: 'idle',
        error: err instanceof Error ? err.message : 'Approval failed.',
      });
    }
  }

  async function handleReject(id: string) {
    patchItemState(id, { requestState: 'rejecting', error: null });
    try {
      await rejectRequest(tenantId, id);
      patchItemState(id, { requestState: 'idle' });
      await queryClient.invalidateQueries({ queryKey: ['approvals', tenantId, sessionId] });
    } catch (err) {
      patchItemState(id, {
        requestState: 'idle',
        error: err instanceof Error ? err.message : 'Rejection failed.',
      });
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="review-gate">
      {fetchError !== null && (
        <p className="rounded-[8px] bg-red-500/10 px-3 py-2 text-[13px] text-red-400">
          {fetchError instanceof Error ? fetchError.message : 'Failed to load approval requests.'}
        </p>
      )}
      {approvals.map((approval: Approval) => {
        const { requestState, error } = getItemState(approval.id);
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
