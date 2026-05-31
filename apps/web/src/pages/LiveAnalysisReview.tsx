import { useState, useEffect, useRef } from 'react';
import StepSidebar from '../components/StepSidebar';
import TranscriptPanel from '../components/TranscriptPanel';
import ProgressChecklist from '../components/ProgressChecklist';
import PainPointsList from '../components/PainPointsList';
import { useWorkflow, useRunStep, useUpdateCompanyName } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import { logger } from '../lib/logger';
import type { Stage } from '../App';

interface LiveAnalysisReviewProps {
  workflowId: string;
  onStageChange?: (stage: Stage) => void;
}

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

export default function LiveAnalysisReview({ workflowId, onStageChange }: LiveAnalysisReviewProps) {
  const { data: workflow, isLoading: isLoadingWorkflow } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const updateCompanyName = useUpdateCompanyName(workflowId);
  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [stepError, setStepError] = useState('');
  const [companyNameInput, setCompanyNameInput] = useState<string>('');
  const analyzeTriggered = useRef(false);
  const companyNameInitialized = useRef(false);

  const painPoints = (workflow?.steps?.analyze?.painPoints as any[]) ?? [];
  const analyzeCompleted = workflow?.steps?.analyze?.completed ?? false;

  // Sync company name from server once after analysis completes
  useEffect(() => {
    if (!workflow || !analyzeCompleted || companyNameInitialized.current) return;
    companyNameInitialized.current = true;
    setCompanyNameInput(workflow.companyName ?? '');
  }, [workflow, analyzeCompleted]);

  // Auto-trigger analyze once when workflow is loaded and not yet analyzed
  useEffect(() => {
    if (!workflow || analyzeCompleted || analyzeTriggered.current || runStep.isPending) return;
    analyzeTriggered.current = true;
    runStep.mutateAsync({ step: 'analyze' }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      logger.error('Auto-analyze failed', { workflowId, error: message });
      setStepError(message);
    });
  }, [workflow, analyzeCompleted]);

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = async () => {
    if (selectedIds.size === 0) return;
    setStepError('');
    try {
      await runStep.mutateAsync({
        step: 'generate',
        painPointIds: Array.from(selectedIds),
      });
      onStageChange?.('review');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      logger.error('Generate step failed', { workflowId, error: message });
      setStepError(message);
    }
  };

  const isGenerating = runStep.isPending && analyzeCompleted;
  const isAnalyzing = runStep.isPending && !analyzeCompleted;

  const steps = workflow?.currentStep
    ? buildSteps(workflow.currentStep, STEP_LABELS)
    : buildSteps('analyze', STEP_LABELS);

  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

  logger.info('LiveAnalysisReview render', {
    workflowId,
    isLoadingWorkflow,
    isPending: runStep.isPending,
    analyzeCompleted,
    painPointsCount: painPoints.length,
  });

  return (
    <div className="flex h-screen bg-gray-50">
      <StepSidebar steps={steps} sourceLabel={sourceLabel} selectionCount={selectedIds.size} />

      <div className="flex-1 flex overflow-hidden">
        <TranscriptPanel
          transcript={workflow?.steps?.intake?.transcript as string}
          isLoading={isLoadingWorkflow}
        />

        {/* Right panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-6 border-b border-amber-100 bg-white">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Live Review
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Agent is extracting pain points</h2>
            <p className="text-sm text-gray-600 mt-1">
              A running view of what the automation is reading, deciding, and preparing for approval
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <ProgressChecklist
              status={
                stepError
                  ? 'error'
                  : isAnalyzing
                    ? 'running'
                    : analyzeCompleted
                      ? 'completed'
                      : 'idle'
              }
            />
            {stepError && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700 font-medium">Error: {stepError}</p>
              </div>
            )}
            <PainPointsList
              points={painPoints}
              selectedIds={selectedIds}
              onToggle={handleToggle}
              isLoading={isAnalyzing}
              analyzeCompleted={analyzeCompleted}
            />
          </div>

          {analyzeCompleted && (
            <div className="p-6 border-t border-gray-200 bg-white space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Company name</label>
                <input
                  type="text"
                  value={companyNameInput}
                  onChange={(e) => setCompanyNameInput(e.target.value)}
                  onBlur={() => {
                    const val = companyNameInput.trim() || null;
                    if (val !== (workflow?.companyName ?? null)) {
                      updateCompanyName.mutate(val);
                    }
                  }}
                  placeholder="Extracted automatically — override if needed"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Add context, corrections, or a stronger angle..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none h-20"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {selectedIds.size} pain point{selectedIds.size !== 1 ? 's' : ''} selected
                </span>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || selectedIds.size === 0}
                  className="px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isGenerating ? 'Generating...' : 'Generate collateral'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
