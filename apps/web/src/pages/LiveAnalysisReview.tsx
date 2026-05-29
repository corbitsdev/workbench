import { useState } from 'react';
import StepSidebar from '../components/StepSidebar';
import TranscriptPanel from '../components/TranscriptPanel';
import ProgressChecklist from '../components/ProgressChecklist';
import PainPointsList from '../components/PainPointsList';
import FeedbackSection from '../components/FeedbackSection';
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
        <TranscriptPanel transcript={workflow?.steps?.intake?.transcript as string} />

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
            <ProgressChecklist />
            <PainPointsList points={painPoints} selectedIds={selectedIds} onToggle={handleToggle} />
          </div>

          <FeedbackSection
            feedback={feedback}
            onFeedbackChange={setFeedback}
            analyzeCompleted={workflow?.steps?.analyze?.completed ?? false}
            selectedCount={selectedCount}
            isLoading={isLoading}
            onAnalyze={handleAnalyze}
            onGenerate={handleGenerate}
          />
        </div>
      </div>
    </div>
  );
}
