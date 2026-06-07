import { useState } from 'react';
import { useWorkflow, useRunStep, isExportStepResult } from '../hooks/use-workflow';
import PainPointsList from './PainPointsList';
import FeedbackSection from './FeedbackSection';
import ArtifactBody from './ArtifactBody';
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

function ExportPanel({ content, onCopy }: { content: string; onCopy: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface shrink-0">
        <span className="text-[13px] font-semibold text-text">Final package</span>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 hover:text-text hover:border-orange transition-colors"
        >
          Copy
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <pre className="whitespace-pre-wrap text-[13px] font-mono text-text leading-relaxed">
          {content}
        </pre>
      </div>
    </div>
  );
}

export function WorkflowPanel({ workflowId, onClose }: WorkflowPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);

  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [improveFeedback, setImproveFeedback] = useState('');
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [exportContent, setExportContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Loading job…</p>
      </div>
    );
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Could not load job.</p>
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

  const title = workflow.companyName ?? painPoints[0]?.context ?? 'Job';

  const STEP_LABELS: Record<StepName, string> = {
    intake: 'Intake',
    analyze: 'Analyze',
    generate: 'Generate',
    improve: 'Improve',
    export: 'Export',
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

  const handleAnalyze = () => {
    void runStep.mutateAsync({ step: 'analyze', feedback: feedback.trim() || undefined });
  };

  const handleGenerate = () => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : painPoints.map((p) => p.id);
    void runStep.mutateAsync({ step: 'generate', painPointIds: ids });
  };

  const handleImprove = (artifactId: string) => {
    if (!improveFeedback.trim()) return;
    void runStep.mutateAsync({
      step: 'improve',
      artifactId,
      feedback: improveFeedback.trim(),
    });
    setImproveFeedback('');
  };

  const handleExport = async () => {
    const result = await runStep.mutateAsync({ step: 'export' });
    if (isExportStepResult(result)) {
      setExportContent(result.export.content);
    }
  };

  const handleCopy = () => {
    if (!exportContent) return;
    void navigator.clipboard.writeText(exportContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
        <button
          type="button"
          onClick={onClose}
          aria-label="Close job"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
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

      {/* Step progress */}
      <HorizontalStepper steps={steps} />

      {/* Export view */}
      {exportContent ? (
        <ExportPanel content={exportContent} onCopy={handleCopy} />
      ) : (
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

          {/* Pain points pane — shown during analyze/generate phases */}
          {!generateCompleted && (
            <div className="flex-1 overflow-y-auto p-5">
              <PainPointsList
                points={painPoints}
                selectedIds={selectedIds}
                onToggle={handleToggle}
                isLoading={isBusy}
                analyzeCompleted={analyzeCompleted}
              />
            </div>
          )}

          {/* Bottom action bar */}
          {!generateCompleted && (
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

          {generateCompleted && displayArtifact && (
            <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-2">
              {currentStep !== 'export' && (
                <>
                  <textarea
                    value={improveFeedback}
                    onChange={(e) => setImproveFeedback(e.target.value)}
                    placeholder="Suggest improvements to this draft…"
                    rows={2}
                    disabled={isBusy}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface-2 text-text resize-none focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isBusy || !improveFeedback.trim()}
                      onClick={() => handleImprove(displayArtifact.id)}
                      className="flex-1 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-text-2 hover:text-text hover:border-orange disabled:opacity-50 transition-colors"
                    >
                      {isBusy ? 'Working…' : 'Improve'}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleExport()}
                      className="flex-1 btn-primary"
                    >
                      {isBusy ? 'Exporting…' : 'Export package'}
                    </button>
                  </div>
                </>
              )}
              {currentStep === 'export' && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleExport()}
                  className="w-full btn-primary"
                >
                  {isBusy ? 'Exporting…' : 'Export package'}
                </button>
              )}
              {copied && <p className="text-[12px] text-green text-center">Copied to clipboard</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
