import { useState } from 'react';
import { motion } from 'framer-motion';
import StepSidebar from '../components/StepSidebar';
import { useWorkflow, useRunStep } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
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
  const [feedback, setFeedback] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const painPoints = (workflow?.steps?.analyze?.painPoints as any[]) ?? [];
  const selectedCount = selectedIds.size;

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAnalyze = async () => {
    await runStep.mutateAsync({ step: 'analyze', feedback: feedback.trim() || undefined });
  };

  const handleGenerate = async () => {
    if (selectedCount === 0) return;
    const ids = Array.from(selectedIds);
    await runStep.mutateAsync({ step: 'generate', painPointIds: ids });
    onStageChange?.('review');
  };

  const isLoading = isLoadingWorkflow || runStep.isPending;

  const steps = workflow?.currentStep
    ? buildSteps(workflow.currentStep, STEP_LABELS)
    : buildSteps('analyze', STEP_LABELS);

  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

  return (
    <div className="flex h-screen bg-gray-50">
      <StepSidebar steps={steps} sourceLabel={sourceLabel} selectionCount={selectedIds.size} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Transcript */}
        <motion.div
          className="w-80 bg-amber-50 border-r border-amber-100 flex flex-col overflow-hidden"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        >
          <div className="p-6 border-b border-amber-100">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Transcript
            </div>
            <h2 className="text-xl font-bold text-gray-900">Source context</h2>
            <p className="text-sm text-gray-600 mt-1">
              The original call stays visible as the agent extracts useful customer language
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {(workflow?.steps?.intake?.transcript as string) ?? 'Loading...'}
            </p>
          </div>
        </motion.div>

        {/* Right Panel: Analysis */}
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
            {/* Progress Checklist */}
            <div className="space-y-2 mb-6">
              {[
                'Reading transcript turns and speaker roles',
                'Clustering repeated objections and urgency cues',
                'Pulling exact customer language for reuse',
                'Drafting pain-point summaries for approval',
              ].map((task, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.1 }}
                  className="flex items-center gap-3 text-sm"
                >
                  <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-white text-xs">
                    ✓
                  </div>
                  <span className="text-gray-700">{task}</span>
                </motion.div>
              ))}
            </div>

            {/* Pain Points */}
            <div className="space-y-3">
              {painPoints.map((point: any) => (
                <motion.div
                  key={point.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`border rounded-lg p-4 transition-all ${
                    selectedIds.has(point.id)
                      ? 'border-green-300 bg-green-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <div
                    className="flex items-start gap-3 cursor-pointer"
                    onClick={() => handleToggle(point.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(point.id)}
                      onChange={(e) => {
                        e.stopPropagation();
                        handleToggle(point.id);
                      }}
                      className="mt-1 w-4 h-4"
                    />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 text-sm">{point.context}</h3>
                      <p className="text-xs text-gray-600 mt-2 italic">&quot;{point.quote}&quot;</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Feedback Input */}
          <div className="p-6 border-t border-gray-200 bg-white space-y-4">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Add context, corrections, or a stronger angle..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none h-20"
            />

            {!workflow?.steps?.analyze?.completed && (
              <button
                onClick={handleAnalyze}
                disabled={isLoading}
                className="w-full px-4 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading
                  ? 'Analyzing...'
                  : feedback.trim()
                    ? 'Run analysis with feedback'
                    : 'Run analysis'}
              </button>
            )}

            {workflow?.steps?.analyze?.completed && (
              <button
                onClick={handleGenerate}
                disabled={isLoading || selectedCount === 0}
                className="w-full px-4 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? 'Generating...' : 'Generate collateral'}
              </button>
            )}

            <p className="text-xs text-gray-500">
              {selectedCount} pain point{selectedCount !== 1 ? 's' : ''} selected
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
