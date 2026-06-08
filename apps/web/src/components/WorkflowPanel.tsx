import { useState } from 'react';
import { useWorkflow, useRunStep } from '../hooks/use-workflow';
import PainPointsList from './PainPointsList';
import FeedbackSection from './FeedbackSection';
import ArtifactBody from './ArtifactBody';
import { WorkflowStepConfig } from './WorkflowStepConfig';
import { HorizontalStepper, buildSteps } from '@workbench/workflow';
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

const COLLATERAL_OPTIONS = [
  { id: 'follow-up-email', label: 'Follow-up Email' },
  { id: 'pain-points-linkedin-post', label: 'Pain Points LinkedIn Post' },
  { id: 'sales-one-pager', label: 'Sales One-Pager' },
  { id: 'battlecard', label: 'Battlecard' },
  { id: 'pain-points-twitter-post', label: 'Pain Points Twitter Post' },
  { id: 'pain-points-blog', label: 'Pain Points Blog' },
  { id: 'founder-pov-post', label: 'Founder POV Post' },
  { id: 'case-study-draft', label: 'Case Study Draft' },
  { id: 'objection-handling-doc', label: 'Objection Handling Doc' },
  { id: 'customer-quote-pulls', label: 'Customer Quote Pulls' },
];

const DEFAULT_COLLATERAL_TYPES = [
  'follow-up-email',
  'pain-points-linkedin-post',
  'sales-one-pager',
  'battlecard',
];

export function WorkflowPanel({ workflowId, onClose }: WorkflowPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);

  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collateralTypes, setCollateralTypes] = useState<Set<string>>(
    new Set(DEFAULT_COLLATERAL_TYPES)
  );
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

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
  const generateCompleted = Boolean(generateStep?.completed);
  const isBusy = runStep.isPending;

  const title = workflow.companyName ?? painPoints[0]?.context ?? 'Workflow';

  const STEP_LABELS: Record<StepName, string> = {
    intake: 'Intake',
    analyze: 'Analyze',
    generate: 'Generate',
  };

  const steps = buildSteps(currentStep, STEP_LABELS, workflow.status === 'done');

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
    const ids = selectedIds.size > 0 ? [...selectedIds] : painPoints.map((p) => p.id);
    const types = collateralTypes.size > 0 ? [...collateralTypes] : DEFAULT_COLLATERAL_TYPES;
    void runStep.mutateAsync({ step: 'generate', painPointIds: ids, collateralTypes: types });
  };

  // Determine active artifact
  const displayArtifact =
    artifacts.find((a) => a.id === activeArtifactId) ?? artifacts[artifacts.length - 1] ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{title}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">
            {currentStep} · {workflow.status}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            aria-label={configOpen ? 'Close step configuration' : 'Configure steps'}
            title={configOpen ? 'Close step configuration' : 'Configure steps'}
            className={`grid h-[28px] w-[28px] place-items-center rounded-[8px] border transition-colors ${
              configOpen
                ? 'border-orange text-text bg-[rgba(233,132,40,0.08)]'
                : 'border-border text-text-2 hover:text-text hover:bg-surface-2'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close workflow"
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

      {/* Step configuration panel */}
      {configOpen && (
        <div className="border-b border-border bg-surface px-5 py-4 shrink-0">
          <WorkflowStepConfig workflowId={workflowId} currentConfig={workflow.stepConfig ?? {}} />
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Artifact pane — shown once generate is done */}
        {generateCompleted && displayArtifact && (
          <div className="flex-1 overflow-y-auto">
            {/* Artifact tabs */}
            {artifacts.length > 1 && (
              <div className="flex gap-1 px-4 pt-3 pb-1 border-b border-border overflow-x-auto">
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
            <div className="p-5">
              <ArtifactBody body={displayArtifact.content} type={displayArtifact.kind} />
            </div>
          </div>
        )}

        {/* Pain points + collateral selection — shown during analyze/generate phases */}
        {!generateCompleted && (
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
                  {COLLATERAL_OPTIONS.map((option) => {
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
        {!generateCompleted && (
          <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-3">
            {!analyzeCompleted && (
              <FeedbackSection
                feedback={feedback}
                onFeedbackChange={setFeedback}
                analyzeCompleted={analyzeCompleted}
                selectedCount={selectedIds.size || (analyzeCompleted ? painPoints.length : 0)}
                isLoading={isBusy}
                onAnalyze={handleAnalyze}
                onGenerate={handleGenerate}
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
                  {isBusy ? 'Generating...' : 'Generate collateral'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
