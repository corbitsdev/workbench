import { useState } from 'react';
import {
  useWorkflow,
  useRunStep,
  useApproveArtifact,
  useWorkbenchAgents,
} from '../hooks/use-workflow';
import { CheckIcon } from 'lucide-react';
import PainPointsList from './PainPointsList';
import FeedbackSection from './FeedbackSection';
import ArtifactBody from './ArtifactBody';
import { AgentChat } from './AgentChat';
import { HorizontalStepper, buildSteps } from '@workbench/workflow';
import { collateralTypeOptions, hasMultiVariantKind } from '@workbench/gtm-workflows';
import type { ArtifactKind } from '@workbench/shared';
import type { StepName } from '@workbench/workflow';

interface WorkflowPanelProps {
  workflowId: string;
  onClose: () => void;
}

interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  status: string;
}

interface PainPointData {
  id: string;
  context: string;
  quote: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  selected?: boolean;
}

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

  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collateralTypes, setCollateralTypes] = useState<Set<string>>(new Set());
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [showLincolnChat, setShowLincolnChat] = useState(false);

  const generateCompleted = Boolean(workflow?.steps.generate?.completed);
  const { data: allAgents = [] } = useWorkbenchAgents({ enabled: generateCompleted });

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

  const currentStep = workflow.currentStep;
  const analyzeStep = workflow.steps.analyze;
  const generateStep = workflow.steps.generate;
  const painPoints: PainPointData[] =
    (analyzeStep?.painPoints as PainPointData[] | undefined) ?? [];
  const artifacts: Artifact[] = (generateStep?.artifacts as Artifact[] | undefined) ?? [];
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
    void runStep.mutateAsync({ step: 'analyze', feedback: feedback.trim() || undefined });
  };

  const handleGenerate = () => {
    if (selectedIds.size === 0 || collateralTypes.size === 0) return;
    void runStep.mutateAsync({
      step: 'generate',
      painPointIds: [...selectedIds],
      collateralTypes: [...collateralTypes],
    });
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
    void approveArtifact.mutateAsync({ artifactId: displayArtifact.id, status }).then(() => {
      setActiveArtifactId(nextDraft?.id ?? null);
    });
  };

  const kindLabel =
    collateralTypeOptions.find((o) => o.id === displayArtifact?.kind)?.label ??
    displayArtifact?.kind ??
    null;

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
            {STEP_LABELS[stepperStep] ?? stepperStep} ·{' '}
            {STATUS_LABELS[workflow.status] ?? workflow.status}
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
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green/[0.18]">
                  <CheckIcon className="h-4 w-4 text-green" />
                </div>
                <p className="text-[14px] font-semibold text-text">All artifacts reviewed</p>
              </div>
              {approvedArtifacts.length > 0 ? (
                <>
                  <ul className="space-y-1.5">
                    {approvedArtifacts.map((a) => (
                      <li
                        key={a.id}
                        className="rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text"
                      >
                        {a.title}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[12px] text-text-3">
                    Your approved pieces have been saved to Artifacts.
                  </p>
                </>
              ) : (
                <p className="text-[12px] text-text-3">
                  All pieces were denied. No artifacts were saved.
                </p>
              )}
            </div>
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
                <ArtifactBody body={displayArtifact.content} type={displayArtifact.kind} />
              </div>
              {displayArtifact.status === 'draft' && (
                <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-bg/95 px-5 py-3 backdrop-blur-sm">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={approveArtifact.isPending}
                      onClick={() => handleApproveOrDeny('rejected')}
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

        {/* Pain points + collateral selection — shown during analyze/generate phases */}
        {!generateCompleted && !isGenerating && (
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

        {/* Bottom action bar */}
        {!generateCompleted && isGenerating && (
          <div className="border-t border-border bg-surface px-4 py-3 shrink-0">
            <button type="button" disabled className="btn-primary w-full">
              Generating…
            </button>
          </div>
        )}
        {!generateCompleted && !isGenerating && (
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
                  {selectedIds.size} pain point{selectedIds.size !== 1 ? 's' : ''} selected
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
    </div>
  );
}
