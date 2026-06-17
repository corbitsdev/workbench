import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useWorkflow } from '../../hooks/use-workflow';
import type { AbComparisonBranch, AbComparisonRanking } from '@workbench/gtm-workflows';
import type { WorkflowSelectedPanelProps } from '../registry';

function formatRankLabel(rankIndex: number): string {
  if (rankIndex < 0) return 'Unranked';
  if (rankIndex === 0) return '1st';
  if (rankIndex === 1) return '2nd';
  if (rankIndex === 2) return '3rd';
  return `${rankIndex + 1}th`;
}

export function AbComparisonSelectedPanel({ workflowId, onClose }: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const queryClient = useQueryClient();
  const [ranking, setRanking] = useState<AbComparisonRanking | null>(null);
  const [feedbackByBranch, setFeedbackByBranch] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState('');

  const runStep = useMutation({
    mutationFn: async (step: string) => {
      return api<{ status: string }>('POST', `/workflows/${workflowId}/steps`, { step });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });

  const persistMutation = useMutation({
    mutationFn: async () => {
      return api<{ status: string }>('POST', `/workflows/${workflowId}/steps`, {
        step: 'persist',
        ranking: ranking ?? undefined,
        feedback: feedbackByBranch,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });

  const updateRanking = useMutation({
    mutationFn: async (next: AbComparisonRanking) => {
      return api<{ status: string }>('PATCH', `/workflows/${workflowId}/step-data`, {
        ranking: next,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });

  const updateFeedback = useMutation({
    mutationFn: async (feedback: Record<string, string>) => {
      return api<{ status: string }>('PATCH', `/workflows/${workflowId}/step-data`, {
        feedback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Loading workflow…</p>
      </div>
    );
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Could not load workflow.</p>
      </div>
    );
  }

  const steps = workflow.steps as Record<string, { completed: boolean; [key: string]: unknown }>;
  const providersStep = steps['providers'];
  const configureStep = steps['configure'];
  const inputStep = steps['input'];
  const executeStep = steps['execute'];
  const compareStep = steps['compare'];
  const feedbackStep = steps['feedback'];

  const branches = (executeStep?.branches as AbComparisonBranch[] | undefined) ?? [];
  const doneBranches = branches.filter((b) => b.status === 'done' || b.status === 'error');
  const allDone =
    branches.length > 0 && branches.every((b) => b.status === 'done' || b.status === 'error');
  const serverRanking = compareStep?.ranking as AbComparisonRanking | undefined;
  const serverFeedback = feedbackStep?.ranking as { feedback?: Record<string, string> } | undefined;

  const activeRanking = ranking ?? serverRanking ?? null;
  const activeFeedback = { ...serverFeedback?.feedback, ...feedbackByBranch };

  const currentStep = workflow.currentStep ?? 'pending';
  const isRunning =
    currentStep === 'execute' || (workflow.status === 'running' && currentStep === 'execute');
  const isReviewing = currentStep === 'compare';
  const isFeedback = currentStep === 'feedback';
  const isPersist = currentStep === 'persist' || workflow.status === 'done';

  const handleRun = () => {
    setSubmitError('');
    runStep.mutate('execute');
  };

  const handleRank = (branchIds: string[]) => {
    setSubmitError('');
    const next: AbComparisonRanking = { branchIds, feedback: activeFeedback };
    setRanking(next);
    updateRanking.mutate(next);
  };

  const handleFeedbackChange = (branchId: string, value: string) => {
    setFeedbackByBranch((prev) => ({ ...prev, [branchId]: value }));
  };

  const handleSaveFeedback = () => {
    setSubmitError('');
    updateFeedback.mutate(activeFeedback);
  };

  const handlePersist = () => {
    setSubmitError('');
    persistMutation.mutate();
  };

  return (
    <div className="relative flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">Blind A/B Comparison</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">
            {workflow.currentStep} · {workflow.status}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Configuration summary */}
        <div className="rounded-[10px] border border-border p-4 space-y-3">
          <p className="text-[13px] font-semibold text-text">Configuration</p>
          <div className="space-y-2">
            <p className="text-[12px] text-text-3">
              Providers:{' '}
              {((providersStep?.providers as Array<{ providerName: string }> | undefined) ?? [])
                .map((p) => p.providerName)
                .join(', ') || 'None'}
            </p>
            {(configureStep?.systemPrompt as string | undefined) && (
              <p className="text-[12px] text-text-3">
                System prompt: {String(configureStep?.systemPrompt).slice(0, 60)}…
              </p>
            )}
            <p className="text-[12px] text-text-3">
              Input:{' '}
              {(inputStep?.input as { source?: string; text?: string } | undefined)?.source ??
                'none'}
            </p>
          </div>
        </div>

        {/* Run button */}
        {!isRunning && !isReviewing && !isFeedback && !isPersist && branches.length === 0 && (
          <button
            type="button"
            disabled={runStep.isPending}
            onClick={handleRun}
            className="w-full rounded-[9px] bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {runStep.isPending ? 'Starting…' : 'Run comparison'}
          </button>
        )}

        {/* Execution progress */}
        {isRunning && branches.length > 0 && (
          <div className="space-y-3">
            <p className="text-[13px] text-text-2">Running {branches.length} branches…</p>
            <div className="space-y-2">
              {branches.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between rounded-[8px] border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        b.status === 'done'
                          ? 'bg-green'
                          : b.status === 'error'
                            ? 'bg-red'
                            : 'bg-orange animate-pulse'
                      }`}
                    />
                    <span className="text-[12px] font-medium text-text">
                      Branch {b.id.slice(0, 6)}
                    </span>
                  </div>
                  <span className="text-[11px] text-text-3">{b.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Blind comparison */}
        {(isReviewing || isFeedback || isPersist) && allDone && (
          <div className="space-y-4">
            <p className="text-[13px] font-semibold text-text">Blind comparison</p>
            <p className="text-[12px] text-text-3">
              Rank the outputs from best to worst. Provider identities are hidden until you finish.
            </p>

            <div className="grid grid-cols-1 gap-3">
              {doneBranches.map((branch) => {
                const rankIndex = activeRanking?.branchIds.indexOf(branch.id) ?? -1;
                const rankLabel = formatRankLabel(rankIndex);
                return (
                  <div
                    key={branch.id}
                    className={`rounded-[10px] border p-4 transition-colors ${
                      rankIndex === 0
                        ? 'border-green/40 bg-green/[0.06]'
                        : rankIndex >= 0
                          ? 'border-border bg-surface'
                          : 'border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[12px] font-semibold text-text">
                        Output {branch.id.slice(0, 6)}
                      </span>
                      <span className="text-[11px] font-medium text-text-3">{rankLabel}</span>
                    </div>
                    <div className="rounded-[8px] border border-border bg-bg p-3">
                      <pre className="text-[12px] text-text-2 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
                        {branch.output ?? 'No output'}
                      </pre>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={rankIndex === 0 || !activeRanking}
                        onClick={() => {
                          if (!activeRanking) return;
                          const ids = [...activeRanking.branchIds];
                          const idx = ids.indexOf(branch.id);
                          if (idx > 0) {
                            [ids[idx], ids[idx - 1]] = [ids[idx - 1], ids[idx]];
                          }
                          handleRank(ids);
                        }}
                        className="rounded-[7px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 hover:text-text disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={
                          rankIndex === (activeRanking?.branchIds.length ?? 0) - 1 || !activeRanking
                        }
                        onClick={() => {
                          if (!activeRanking) return;
                          const ids = [...activeRanking.branchIds];
                          const idx = ids.indexOf(branch.id);
                          if (idx >= 0 && idx < ids.length - 1) {
                            [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
                          }
                          handleRank(ids);
                        }}
                        className="rounded-[7px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 hover:text-text disabled:opacity-30"
                      >
                        ↓
                      </button>
                      {!activeRanking && (
                        <button
                          type="button"
                          onClick={() =>
                            handleRank([
                              branch.id,
                              ...doneBranches.filter((b) => b.id !== branch.id).map((b) => b.id),
                            ])
                          }
                          className="rounded-[7px] border border-orange/40 bg-orange/10 px-2 py-1 text-[11px] font-medium text-orange hover:bg-orange/[0.16]"
                        >
                          Pick as best
                        </button>
                      )}
                    </div>

                    {/* Feedback per output */}
                    {(isFeedback || isPersist) && (
                      <div className="mt-3">
                        <textarea
                          value={activeFeedback[branch.id] ?? ''}
                          onChange={(e) => handleFeedbackChange(branch.id, e.target.value)}
                          placeholder={`Optional feedback for output ${branch.id.slice(0, 6)}…`}
                          rows={2}
                          className="w-full resize-none rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Ranking actions */}
            {isReviewing && activeRanking && (
              <button
                type="button"
                disabled={updateRanking.isPending}
                onClick={() => handleRank(activeRanking.branchIds)}
                className="w-full rounded-[9px] bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Continue to feedback
              </button>
            )}

            {isFeedback && (
              <>
                <button
                  type="button"
                  disabled={updateFeedback.isPending}
                  onClick={handleSaveFeedback}
                  className="w-full rounded-[9px] bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Save feedback
                </button>
                <button
                  type="button"
                  disabled={persistMutation.isPending}
                  onClick={handlePersist}
                  className="mt-2 w-full rounded-[9px] border border-border bg-surface px-4 py-2 text-[14px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                >
                  Skip feedback and save results
                </button>
              </>
            )}

            {isPersist && !persistMutation.isSuccess && (
              <button
                type="button"
                disabled={persistMutation.isPending}
                onClick={handlePersist}
                className="w-full rounded-[9px] bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {persistMutation.isPending ? 'Saving…' : 'Save results'}
              </button>
            )}

            {isPersist && persistMutation.isSuccess && (
              <p className="text-[13px] text-green">Results saved as artifacts.</p>
            )}
          </div>
        )}

        {submitError && <p className="text-[12px] text-orange-deep">{submitError}</p>}
      </div>
    </div>
  );
}
