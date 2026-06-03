import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import HorizontalStepper from '../components/HorizontalStepper';
import TranscriptPanel from '../components/TranscriptPanel';
import ProgressChecklist from '../components/ProgressChecklist';
import PainPointsList from '../components/PainPointsList';
import { togglePainPointSelection } from '../components/pain-point-selection';
import { useWorkflow, useRunStep, useUpdateCompanyName } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import { logger } from '../lib/logger';

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

export default function LiveAnalysisReview() {
  const { id: workflowId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!workflowId) return null;
  const { data: workflow, isLoading: isLoadingWorkflow } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const updateCompanyName = useUpdateCompanyName(workflowId);
  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [stepError, setStepError] = useState('');
  const [companyNameInput, setCompanyNameInput] = useState<string>('');
  const [showTranscript, setShowTranscript] = useState(false);
  const analyzeTriggered = useRef(false);
  const companyNameInitialized = useRef(false);

  const painPoints = (workflow?.steps?.analyze?.painPoints as any[]) ?? [];
  const analyzeCompleted = workflow?.steps?.analyze?.completed ?? false;
  const isAgentReviewPage = workflow?.currentStep === 'analyze';

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
    setSelectedIds((prev) => togglePainPointSelection(prev, id));
  };

  const handleGenerate = async () => {
    if (selectedIds.size === 0) return;
    setStepError('');
    try {
      await runStep.mutateAsync({
        step: 'generate',
        painPointIds: Array.from(selectedIds),
      });
      navigate(`/workflows/${workflowId}/review`);
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

  logger.info('LiveAnalysisReview render', {
    workflowId,
    isLoadingWorkflow,
    isPending: runStep.isPending,
    analyzeCompleted,
    painPointsCount: painPoints.length,
  });

  return (
    <div className="flex h-screen bg-page text-text">
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Horizontal Stepper */}
        <HorizontalStepper steps={steps} />

        {/* Top Bar: Company — Stepper Layout  — View Transcript */}
        {analyzeCompleted && (
          <div className="shrink-0 px-4 py-3 md:p-6 border-b bg-surface border-border flex items-center justify-between gap-4">
            <div className="flex-1 max-w-xs">
              <label className="block text-xs font-medium mb-1 uppercase tracking-wide text-text-3">
                Company
              </label>
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
                className="w-full px-3 py-2 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange focus:ring-offset-0 border bg-surface-2 text-text border-border"
              />
            </div>
            <button
              onClick={() => setShowTranscript(!showTranscript)}
              className="shrink-0 text-sm font-medium text-orange hover:text-orange-deep transition-colors flex items-center gap-1"
              title={showTranscript ? 'Hide transcript' : 'View transcript'}
            >
              {showTranscript ? '▼' : '▶'} Transcript
            </button>
          </div>
        )}

        {/* Content Area: Transcript or Pain Points */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <AnimatePresence mode="wait">
            {showTranscript ? (
              <motion.div
                key="transcript"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 overflow-hidden"
              >
                <TranscriptPanel
                  transcript={workflow?.steps?.intake?.transcript as string}
                  isLoading={isLoadingWorkflow}
                />
              </motion.div>
            ) : (
              <motion.div
                key="pain-points"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                <div className="flex-1 overflow-y-auto px-4 md:p-6 space-y-4">
                  {isAgentReviewPage && (
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
                  )}
                  {stepError && (
                    <div className="p-4 rounded-lg border border-orange bg-orange-soft bg-opacity-20">
                      <p className="text-sm font-medium text-orange">Error: {stepError}</p>
                    </div>
                  )}
                  <PainPointsList
                    points={painPoints}
                    selectedIds={selectedIds}
                    onToggle={handleToggle}
                    isLoading={isAnalyzing}
                    analyzeCompleted={analyzeCompleted}
                  />
                  {!analyzeCompleted && !isAnalyzing && (
                    <div className="flex justify-center">
                      <button
                        onClick={() => {
                          setStepError('');
                          runStep.mutateAsync({ step: 'analyze' }).catch((err) => {
                            const message = err instanceof Error ? err.message : 'Analysis failed';
                            logger.error('Manual analyze failed', { workflowId, error: message });
                            setStepError(message);
                          });
                        }}
                        disabled={runStep.isPending}
                        className="btn-primary"
                      >
                        {runStep.isPending ? 'Running...' : 'Run analysis'}
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom: Feedback Prompt + Generate Button */}
        {analyzeCompleted && (
          <div className="shrink-0 px-4 py-3 md:p-6 border-t bg-surface border-border space-y-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <input
                  type="text"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Add context, corrections, or a stronger angle..."
                  className="w-full px-3 py-2 rounded text-sm focus:outline-none focus:ring-2 focus:ring-orange focus:ring-offset-0 border bg-surface-2 text-text border-border"
                />
              </div>
              <button
                onClick={handleGenerate}
                disabled={isGenerating || selectedIds.size === 0}
                className="btn-primary whitespace-nowrap"
              >
                {isGenerating
                  ? 'Generating...'
                  : feedback.trim()
                    ? 'Refine Pain Points'
                    : 'Generate collateral'}
              </button>
            </div>
            <div className="flex items-center justify-between text-xs text-text-3">
              <span>
                {selectedIds.size} pain point{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
