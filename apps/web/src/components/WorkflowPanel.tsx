import { useState } from 'react';
import {
  useWorkflow,
  useRunStep,
  useApproveArtifact,
  useRegenerateArtifact,
  useWorkbenchAgents,
} from '../hooks/use-workflow';
import PainPointsList from './PainPointsList';
import { ReviewedArtifactsSummary } from './ReviewedArtifactsSummary';
import FeedbackSection from './FeedbackSection';
import ArtifactBody from './ArtifactBody';
import { AgentChat } from './AgentChat';
import { toHumanLabel } from '@workbench/ui';
import { resolveKindLabel } from '../lib/resolve-kind-label';
import { HorizontalStepper, buildSteps } from '@workbench/workflow';
import { collateralTypeOptions, hasMultiVariantKind } from '@workbench/gtm-workflows';
import type { StepName } from '@workbench/workflow';
import {
  parsePainPoints,
  parseWorkflowArtifacts,
  type ParsedPainPoint,
  type ParsedWorkflowArtifact,
} from '../lib/schemas';

interface WorkflowPanelProps {
  workflowId: string;
  onClose: () => void;
}

type Artifact = ParsedWorkflowArtifact;
type PainPointData = ParsedPainPoint;

// The pain points a generation run was started with: the current in-session
// selection if present, else the server-persisted selection (survives remount).
function getSubmittedPainPoints(
  painPoints: PainPointData[],
  selectedIds: Set<string>
): PainPointData[] {
  if (selectedIds.size > 0) return painPoints.filter((p) => selectedIds.has(p.id));
  return painPoints.filter((p) => p.selected);
}

export function WorkflowPanel({ workflowId, onClose }: WorkflowPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const approveArtifact = useApproveArtifact(workflowId);
  const regenerateArtifact = useRegenerateArtifact(workflowId);

  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collateralTypes, setCollateralTypes] = useState<Set<string>>(new Set());
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [showLincolnChat, setShowLincolnChat] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [showDenyDialog, setShowDenyDialog] = useState(false);
  const [denyFeedback, setDenyFeedback] = useState('');

  const generateCompleted = Boolean(workflow?.steps.generate?.completed);
  const { data: allAgents = [] } = useWorkbenchAgents({
    enabled: generateCompleted,
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

  const workflowKind = workflow.kind;
  const currentStep = workflow.currentStep;
  const analyzeStep = workflow.steps.analyze;
  const generateStep = workflow.steps.generate;
  const painPoints: PainPointData[] = parsePainPoints(analyzeStep?.painPoints);
  const artifacts: Artifact[] = parseWorkflowArtifacts(generateStep?.artifacts);
  const analyzeCompleted = Boolean(analyzeStep?.completed);
  // Active generation is signalled by the server status 'generating' (which
  // survives the request, unlike runStep.isPending), or optimistically the
  // moment the user fires the generate step from the ready state. The 'ready'
  // status (analysis done, awaiting selection) is deliberately NOT busy.
  const isGenerating = workflow.status === 'generating' || (runStep.isPending && analyzeCompleted);
  const isBusy = runStep.isPending || workflow.status === 'analyzing' || isGenerating;

  const title = workflow.companyName ?? painPoints[0]?.context ?? 'Workflow';

  const STATUS_LABELS: Record<string, string> = {
    pending: 'Pending',
    analyzing: 'Analyzing',
    ready: 'Ready',
    generating: 'Generating',
    reviewing: 'Reviewing',
    done: 'Done',
    failed: 'Failed',
  };

  const STEP_LABELS: Record<StepName, string> = {
    intake: 'Intake',
    analyze: 'Analyze',
    generate: 'Generate',
    approve: 'Approve',
  };

  // Approval is a formal step: once generation has produced drafts the workflow
  // sits on 'approve' until every artifact is reviewed, then completes.
  const isReviewing = workflow.status === 'reviewing';
  const stepperStep: StepName = isReviewing ? 'approve' : (currentStep as StepName);
  const steps = buildSteps(stepperStep, STEP_LABELS, workflow.status === 'done');

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCollateralToggle = (id: string) => {
    setCollateralTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAnalyze = () => {
    runStep
      .mutateAsync({
        step: 'analyze',
        feedback: feedback.trim() || undefined,
      })
      .catch(() => {});
  };

  const handleGenerate = () => {
    if (selectedIds.size === 0 || collateralTypes.size === 0) return;
    runStep
      .mutateAsync({
        step: 'generate',
        painPointIds: [...selectedIds],
        collateralTypes: [...collateralTypes],
      })
      .catch(() => {});
  };

  // Determine active artifact — prefer explicit selection, fall back to first draft, then last
  const firstDraft = artifacts.find((a) => a.status === 'draft') ?? null;
  const displayArtifact =
    artifacts.find((a) => a.id === activeArtifactId) ??
    firstDraft ??
    artifacts[artifacts.length - 1] ??
    null;

  const hasDraftArtifacts = artifacts.some((a) => a.status === 'draft');
  const approvedArtifacts = artifacts.filter((a) => a.status === 'approved');
  const hasLinkedInVariants = generateCompleted && hasMultiVariantKind(artifacts);
  const lincolnInstance = allAgents.find((a) => a.agentName === 'Lincoln') ?? null;

  const handleApproveOrDeny = (status: 'approved' | 'rejected') => {
    if (!displayArtifact) return;
    const nextDraft = artifacts.find((a) => a.status === 'draft' && a.id !== displayArtifact.id);
    setApprovalError(null);
    approveArtifact.mutate(
      { artifactId: displayArtifact.id, status },
      {
        onSuccess: () => {
          setActiveArtifactId(nextDraft?.id ?? null);
        },
        onError: () => {
          setApprovalError('Could not save your review. Please try again.');
        },
      }
    );
  };

  const handleDenyWithFeedback = (regenerate: boolean) => {
    if (!displayArtifact) return;
    const artifactId = displayArtifact.id;
    const nextDraft = artifacts.find((a) => a.status === 'draft' && a.id !== artifactId);
    setApprovalError(null);
    setShowDenyDialog(false);
    approveArtifact.mutate(
      { artifactId, status: 'rejected' },
      {
        onSuccess: () => {
          if (regenerate) {
            regenerateArtifact.mutate(
              { artifactId, feedback: denyFeedback.trim() || undefined },
              {
                onError: () => {
                  setApprovalError('Denied, but regeneration failed. Please try again.');
                },
              }
            );
          } else {
            setActiveArtifactId(nextDraft?.id ?? null);
          }
          setDenyFeedback('');
        },
        onError: () => {
          setApprovalError('Could not save your review. Please try again.');
        },
      }
    );
  };

  const kindLabel = resolveKindLabel(displayArtifact?.kind);

  // While generating, the form collapses to a read-only summary of what was
  // submitted. Prefer the in-session selection; after a remount (generation
  // outliving the connection) selectedIds is empty, so fall back to the
  // server-persisted `selected` flag, and only then to all pain points.
  const selectedPainPoints = getSubmittedPainPoints(painPoints, selectedIds);

  return (
    <div className="relative flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{title}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">
            {STEP_LABELS[stepperStep] ?? toHumanLabel(stepperStep)} ·{' '}
            {STATUS_LABELS[workflow.status] ?? toHumanLabel(workflow.status)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
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
      </div>

      {/* Step progress */}
      <HorizontalStepper steps={steps} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Artifact pane — shown once generate is done */}
        {generateCompleted && !hasDraftArtifacts && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <ReviewedArtifactsSummary approvedArtifacts={approvedArtifacts} />
            <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-2">
              {hasLinkedInVariants && lincolnInstance !== null && (
                <button
                  type="button"
                  onClick={() => setShowLincolnChat(true)}
                  className="w-full rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97]"
                >
                  Chat with Lincoln
                </button>
              )}
              <button type="button" onClick={onClose} className="btn-primary w-full">
                Close workflow
              </button>
            </div>
            {showLincolnChat && lincolnInstance !== null && (
              <div className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-panel border border-border bg-bg">
                <AgentChat
                  instanceId={lincolnInstance.id}
                  tenantId={lincolnInstance.tenantId}
                  agentName="Lincoln"
                  instanceStatus={lincolnInstance.status}
                  onClose={() => setShowLincolnChat(false)}
                />
              </div>
            )}
          </div>
        )}

        {generateCompleted && displayArtifact && hasDraftArtifacts && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Artifact tabs — pinned, don't scroll */}
            {artifacts.length > 1 && (
              <div className="flex gap-1 px-4 pt-3 pb-1 border-b border-border overflow-x-auto shrink-0">
                {artifacts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setActiveArtifactId(a.id)}
                    className={`shrink-0 rounded-[8px] px-3 py-1 text-[12px] font-medium transition-colors ${
                      a.id === displayArtifact.id
                        ? 'bg-surface text-text shadow-sm'
                        : 'text-text-2 hover:text-text'
                    }`}
                  >
                    {a.title}
                  </button>
                ))}
              </div>
            )}
            {/* Scrollable content with sticky action bar */}
            <div className="flex-1 overflow-y-auto">
              <div className="p-5 space-y-3">
                {kindLabel && (
                  <span className="inline-block rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-3">
                    {kindLabel}
                  </span>
                )}
                <ArtifactBody artifact={{ ...displayArtifact, sessionId: workflowId }} />
              </div>
              {displayArtifact.status === 'draft' && (
                <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-bg/95 px-5 py-3 backdrop-blur-sm">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={approveArtifact.isPending || regenerateArtifact.isPending}
                      onClick={() => setShowDenyDialog(true)}
                      className="flex-1 rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97] disabled:opacity-50"
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      disabled={approveArtifact.isPending}
                      onClick={() => handleApproveOrDeny('approved')}
                      className="flex-1 rounded-[9px] border border-green/40 bg-green/10 px-3 py-2 text-[13px] font-medium text-green transition-colors hover:bg-green/[0.16] active:scale-[0.97] disabled:opacity-50"
                    >
                      Approve
                    </button>
                  </div>
                  {approvalError !== null && (
                    <p role="alert" className="text-[12px] text-orange-deep">
                      {approvalError}
                    </p>
                  )}
                  {hasLinkedInVariants && lincolnInstance !== null && (
                    <button
                      type="button"
                      onClick={() => setShowLincolnChat(true)}
                      className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97]"
                    >
                      Chat with Lincoln
                    </button>
                  )}
                </div>
              )}
              {displayArtifact.status === 'approved' && (
                <p className="px-5 pb-4 text-[12px] text-text-3">Approved</p>
              )}
              {displayArtifact.status === 'rejected' && (
                <p className="px-5 pb-4 text-[12px] text-text-3">Denied</p>
              )}
            </div>
          </div>
        )}

        {/* Generating — collapse the form to a read-only summary of the submission */}
        {!generateCompleted && isGenerating && (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            <h3 className="text-[13px] font-semibold text-text">
              Generating collateral for {selectedPainPoints.length} pain point
              {selectedPainPoints.length !== 1 ? 's' : ''}
            </h3>
            <ul className="space-y-2">
              {selectedPainPoints.map((p) => (
                <li
                  key={p.id}
                  className="rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text-2"
                >
                  {p.context}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pain points + collateral selection — collateral-generation only */}
        {workflowKind === 'collateral-generation' && !generateCompleted && !isGenerating && (
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* Pain points section */}
            <div>
              <h3 className="text-[13px] font-semibold text-text mb-3">
                Pain points {analyzeCompleted && `(${selectedIds.size} selected)`}
              </h3>
              <PainPointsList
                points={painPoints}
                selectedIds={selectedIds}
                onToggle={handleToggle}
                isLoading={isBusy}
                analyzeCompleted={analyzeCompleted}
              />
            </div>

            {/* Collateral type selection — shown after analyze completes */}
            {analyzeCompleted && (
              <div>
                <h3 className="text-[13px] font-semibold text-text mb-3">
                  Collateral types ({collateralTypes.size} selected)
                </h3>
                <div className="flex flex-wrap gap-2">
                  {collateralTypeOptions.map((option) => {
                    const active = collateralTypes.has(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => handleCollateralToggle(option.id)}
                        className={`rounded-[8px] border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                          active
                            ? 'border-orange bg-orange/8 text-text'
                            : 'border-border text-text-2 hover:border-orange/60 hover:text-text'
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bottom action bar — collateral-generation only */}
        {workflowKind === 'collateral-generation' && !generateCompleted && isGenerating && (
          <div className="border-t border-border bg-surface px-4 py-3 shrink-0">
            <button type="button" disabled className="btn-primary w-full">
              Generating…
            </button>
          </div>
        )}
        {workflowKind === 'collateral-generation' && !generateCompleted && !isGenerating && (
          <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-3">
            {!analyzeCompleted && (
              <FeedbackSection
                feedback={feedback}
                onFeedbackChange={setFeedback}
                analyzeCompleted={analyzeCompleted}
                selectedCount={selectedIds.size}
                isLoading={isBusy}
                onAnalyze={handleAnalyze}
                onGenerate={handleGenerate}
                callName={workflow.companyName ?? undefined}
              />
            )}
            {analyzeCompleted && (
              <>
                <p className="text-xs text-text-3">
                  {selectedIds.size} pain point
                  {selectedIds.size !== 1 ? 's' : ''} selected
                </p>
                <button
                  type="button"
                  disabled={isBusy || selectedIds.size === 0 || collateralTypes.size === 0}
                  onClick={() => handleGenerate()}
                  className="btn-primary w-full"
                >
                  {isBusy ? 'Generating…' : 'Generate collateral'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {showDenyDialog && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-panel bg-bg/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-[14px] border border-border bg-bg p-5 shadow-lg">
            <p className="text-[14px] font-semibold text-text mb-3">Deny collateral</p>
            <textarea
              value={denyFeedback}
              onChange={(e) => setDenyFeedback(e.target.value)}
              placeholder="Optional feedback for regeneration…"
              rows={3}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40 mb-3"
            />
            <div className="flex flex-col gap-2">
              <button
                type="button"
                disabled={approveArtifact.isPending}
                onClick={() => handleDenyWithFeedback(true)}
                className="w-full rounded-[9px] border border-orange/40 bg-orange/10 px-3 py-2 text-[13px] font-medium text-orange transition-colors hover:bg-orange/[0.16] active:scale-[0.97] disabled:opacity-50"
              >
                Deny and regenerate
              </button>
              <button
                type="button"
                disabled={approveArtifact.isPending}
                onClick={() => handleDenyWithFeedback(false)}
                className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97] disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDenyDialog(false);
                  setDenyFeedback('');
                }}
                className="w-full rounded-[9px] px-3 py-2 text-[13px] text-text-3 hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
